/**
 * Provider URL 校验与 JSON 请求辅助。
 *
 * URL 规则：
 * - 仅允许 https://（OpenAI / Anthropic / openai-compatible 都要求 TLS）。
 * - localhost / 127.0.0.1（含 ::1）允许 http://，用于本地模型网关（Ollama 等）。
 * - 阻止明显危险的私网探测目标：拒绝指向非本机私网 / link-local 地址。
 */
import type { AbortSignalLike } from "@prompt-boost/shared";
import { lookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { ProviderError } from "./types.js";
import { mapNetworkError, mapProviderResponse } from "./errors.js";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return LOCAL_HOSTNAMES.has(h);
}

/** 判断 IP 是否属于 loopback（含 IPv4-mapped IPv6）。 */
function isLoopbackAddress(address: string): boolean {
  const h = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)?.[1];
  const value = mapped ?? h;
  return value === "::1" || /^127\./.test(value);
}

/**
 * 拒绝私网、loopback、link-local、保留与组播地址。导出供回归测试覆盖
 * IPv4-mapped IPv6 等容易漏掉的表示形式。
 */
export function isBlockedAddress(address: string): boolean {
  const h = address.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h)?.[1];
  if (mapped) return isBlockedAddress(mapped);
  if (isIP(h) === 4) {
    const octets = h.split(".").map(Number);
    const a = octets[0] ?? -1;
    const b = octets[1] ?? -1;
    const c = octets[2] ?? -1;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  if (isIP(h) === 6) {
    const words = expandIpv6(h);
    if (!words) return true;
    // URL 会把 ::ffff:127.0.0.1 规范化为 ::ffff:7f00:1；按完整 128 位
    // 结构识别 mapped/compatible IPv4，避免仅匹配点分字符串造成绕过。
    const mappedPrefix = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
    const compatiblePrefix = words.slice(0, 6).every((word) => word === 0);
    if (mappedPrefix || compatiblePrefix) {
      const ipv4 = [
        (words[6] ?? 0) >> 8,
        (words[6] ?? 0) & 0xff,
        (words[7] ?? 0) >> 8,
        (words[7] ?? 0) & 0xff,
      ].join(".");
      return isBlockedAddress(ipv4);
    }
    const first = words[0] ?? 0;
    return (
      h === "::" ||
      h === "::1" ||
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xff00) === 0xff00 ||
      (words[0] === 0x2001 && words[1] === 0x0db8)
    );
  }
  return true;
}

/** 展开合法 IPv6 为 8 个 16-bit word，支持压缩写法与末尾点分 IPv4。 */
function expandIpv6(address: string): number[] | null {
  let value = address.split("%")[0];
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const octets = value
      .slice(lastColon + 1)
      .split(".")
      .map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    ) {
      return null;
    }
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    value = `${value.slice(0, lastColon)}:${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string): number[] | null => {
    if (!half) return [];
    const parts = half.split(":");
    if (parts.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
    return parts.map((part) => Number.parseInt(part, 16));
  };
  const left = parseHalf(halves[0] ?? "");
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const zeroCount = 8 - left.length - right.length;
  if (zeroCount < 1) return null;
  return [...left, ...Array<number>(zeroCount).fill(0), ...right];
}

function isPrivateHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return isIP(h) > 0 && isBlockedAddress(h);
}

/**
 * 由 undici 的实际连接过程调用，校验并固定本次连接使用的 DNS 结果。
 * 因为校验发生在 socket lookup 本身，而不是提前预查，可阻断 DNS rebinding 的
 * “预查为公网、连接时变私网”窗口。
 */
function safeLookup(
  hostname: string,
  rawOptions: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    address?: string | LookupAddress[],
    family?: number,
  ) => void,
): void {
  lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) {
      callback(err);
      return;
    }
    const allowLoopback = isLoopback(hostname);
    const unsafe = addresses.some(({ address }) =>
      allowLoopback ? !isLoopbackAddress(address) : isBlockedAddress(address),
    );
    if (unsafe || addresses.length === 0) {
      const blocked = new Error("Provider hostname resolved to a blocked address") as NodeJS.ErrnoException;
      blocked.code = "ERR_BLOCKED_ADDRESS";
      callback(blocked);
      return;
    }
    const options = rawOptions as { all?: boolean; family?: number };
    if (options.all) {
      callback(null, addresses);
      return;
    }
    const selected =
      addresses.find(({ family }) => !options.family || family === options.family) ?? addresses[0];
    callback(null, selected.address, selected.family);
  });
}

const SAFE_DISPATCHER = new Agent({
  connect: { lookup: safeLookup as never },
});

/** 校验 Provider Base URL 的安全性并返回规范化 URL。 */
export function resolveBaseUrl(
  type: string,
  baseUrl: string | undefined,
): string {
  let url: URL;
  try {
    url = new URL(baseUrl ?? "");
  } catch {
    throw new ProviderError({
      code: "INVALID_REQUEST",
      providerType: type,
      retryable: false,
      safeMessage: "Base URL 无效",
    });
  }

  if (url.protocol === "http:") {
    // 只允许 loopback 明文 HTTP。
    if (!isLoopback(url.hostname)) {
      throw new ProviderError({
        code: "INVALID_REQUEST",
        providerType: type,
        retryable: false,
        safeMessage: "Base URL 仅允许 https://，或 http:// 仅限 localhost/127.0.0.1",
      });
    }
  } else if (url.protocol !== "https:") {
    throw new ProviderError({
      code: "INVALID_REQUEST",
      providerType: type,
      retryable: false,
      safeMessage: "Base URL 仅支持 https://",
    });
  }

  // 非 loopback 的私网/保留地址一律拒绝（防止内网探测）。
  if (!isLoopback(url.hostname) && isPrivateHostname(url.hostname)) {
    throw new ProviderError({
      code: "INVALID_REQUEST",
      providerType: type,
      retryable: false,
      safeMessage: "Base URL 不得指向非本机私网地址",
    });
  }

  return url.toString().replace(/\/+$/, "");
}

export interface JsonPostOptions {
  providerType: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  signal?: AbortSignalLike;
}

/**
 * 合并内部超时信号与调用方中止信号，任一触发即中止。
 * 修复 F：修复前 `signal: opts.signal ?? AbortSignal.timeout(timeoutMs)` 在断连
 * signal 恒存在时把 Provider 的 timeoutSeconds 完全架空（超时永不触发）。
 * 不用 AbortSignal.any：测试环境（jsdom）与部分旧 Node 无该 API。
 */
function combineSignals(
  timeoutMs: number,
  outer: AbortSignalLike | undefined,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const inner = AbortSignal.timeout(timeoutMs);
  const abort = (): void => controller.abort();
  inner.addEventListener("abort", abort, { once: true });
  if (outer) {
    if (outer.aborted) abort();
    else outer.addEventListener?.("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      inner.removeEventListener("abort", abort);
      outer?.removeEventListener?.("abort", abort);
    },
  };
}

/** 发起 JSON POST 请求，统一处理超时/网络/HTTP 错误映射。返回解析后的响应体。 */
export async function postJson(opts: JsonPostOptions): Promise<unknown> {
  return requestJson(opts, "POST");
}

/** 发起 JSON GET 请求（如 OpenAI /models），统一错误映射。 */
export async function getJson(opts: JsonPostOptions): Promise<unknown> {
  return requestJson(opts, "GET");
}

async function requestJson(opts: JsonPostOptions, method: "POST" | "GET"): Promise<unknown> {
  let response: Awaited<ReturnType<typeof undiciFetch>>;
  let bodyText: string;
  const combined = combineSignals(opts.timeoutMs, opts.signal);
  try {
    response = await undiciFetch(opts.url, {
      method,
      headers: { "Content-Type": "application/json", ...opts.headers },
      body: method === "POST" ? JSON.stringify(opts.body) : undefined,
      // 内部超时与调用方断连 signal 合并：任一触发即中止，
      // Provider 的 timeoutSeconds 不再被断连 signal 架空。
      signal: combined.signal,
      dispatcher: SAFE_DISPATCHER,
      // API 调用无需浏览器式跳转；禁止逐跳转向 localhost/私网形成 SSRF。
      redirect: "error",
    });
    bodyText = await readResponseText(response, opts.providerType);
  } catch (err) {
    throw mapNetworkError(opts.providerType, err);
  } finally {
    combined.cleanup();
  }

  const mapped = mapProviderResponse(opts.providerType, response.status, bodyText);
  if (mapped) throw mapped;

  if (!bodyText) {
    throw new ProviderError({
      code: "RESPONSE_INVALID",
      providerType: opts.providerType,
      status: response.status,
      retryable: false,
      safeMessage: "Provider 返回了空响应",
    });
  }
  try {
    return JSON.parse(bodyText);
  } catch {
    throw new ProviderError({
      code: "RESPONSE_INVALID",
      providerType: opts.providerType,
      status: response.status,
      retryable: false,
      safeMessage: "Provider 返回了无法解析的 JSON",
    });
  }
}

/** 有界读取 Provider 响应，防止兼容网关用超大响应耗尽本机内存。 */
async function readResponseText(
  response: Awaited<ReturnType<typeof undiciFetch>>,
  providerType: string,
): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw responseTooLarge(providerType, response.status);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let output = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw responseTooLarge(providerType, response.status);
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function responseTooLarge(providerType: string, status: number): ProviderError {
  return new ProviderError({
    code: "RESPONSE_INVALID",
    providerType,
    status,
    retryable: false,
    safeMessage: "Provider 响应过大，已中止读取",
  });
}

/** 合并自定义请求头与默认头（自定义头优先级最高）。 */
export function mergeHeaders(
  defaults: Record<string, string>,
  custom: Record<string, string> | undefined,
): Record<string, string> {
  return { ...defaults, ...(custom ?? {}) };
}
