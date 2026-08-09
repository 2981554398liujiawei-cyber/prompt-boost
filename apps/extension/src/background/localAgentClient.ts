/**
 * 本地服务客户端：background 通过 fetch 与 local-agent 通信。
 * 统一错误标准化（网络 / HTTP / 校验 / 本地服务错误）。
 */
import {
  LocalAgentErrorCode,
  type AbortSignalLike,
  type LocalAgentFailure,
  type LocalAgentRequest,
  type LocalAgentResponse,
  type LocalAgentResult,
} from "@prompt-boost/shared";

const DEFAULT_TIMEOUT_MS = 15_000;

/** /v1/enhance 走真实 LLM 生成，可能耗时 20s 以上，不得用 15s 默认值截断。 */
export const ENHANCE_TIMEOUT_MS = 90_000;

interface LocalAgentClientOptions {
  baseUrl?: string;
  getToken: () => string | undefined;
}

/** 从扩展设置构造客户端选项。 */
export function clientOptionsFrom(
  settings: { localAgentUrl: string },
  token: string,
): LocalAgentClientOptions {
  return {
    baseUrl: settings.localAgentUrl,
    getToken: () => token,
  };
}

/** 是否为中止（超时 / 显式取消）：AbortSignal.timeout 抛出的是 DOMException，其 name 是 TimeoutError。 */
function isAbort(err: unknown): boolean {
  return (
    err instanceof DOMException ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/** 连接被拒绝 / DNS 失败 / CORS 等网络层失败。 */
function isNetworkError(err: unknown): boolean {
  return err instanceof Error && err.name === "TypeError";
}

/**
 * 合并内部超时信号与调用方中止信号，任一触发即中止。
 * 不用 AbortSignal.any：测试环境（jsdom）与部分旧 Node 无该 API。
 */
function combineSignals(
  timeoutMs: number,
  outer: AbortSignalLike | undefined,
): AbortSignal {
  const controller = new AbortController();
  const inner = AbortSignal.timeout(timeoutMs);
  inner.addEventListener("abort", () => controller.abort());
  if (outer) {
    outer.addEventListener?.("abort", () => controller.abort());
  }
  return controller.signal;
}

/** 发起请求并标准化失败。 */
export async function requestLocalAgent<TBody, TData>(
  options: LocalAgentClientOptions,
  req: LocalAgentRequest<TBody>,
): Promise<LocalAgentResponse<TData>> {
  const baseUrl = options.baseUrl ?? "http://127.0.0.1:8787";
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const query =
    req.query && Object.keys(req.query).length > 0
      ? `?${new URLSearchParams(req.query).toString()}`
      : "";

  // 合并调用方 signal（如 /v1/enhance 的 90s 上限）与请求级 timeout。
  // requestAbortSignal 来自内部请求链（background），运行时必为真实 AbortSignal；
  // 类型上用 AbortSignalLike 仅因 shared 不依赖 DOM lib。
  const signal = combineSignals(timeoutMs, req.requestAbortSignal);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${req.path}${query}`, {
      method: req.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.getToken() ?? ""}`,
      },
      body:
        req.method !== "GET" && req.body !== undefined
          ? JSON.stringify(req.body)
          : undefined,
      signal,
    });
  } catch (err) {
    const aborted = isAbort(err);
    const network: LocalAgentFailure = {
      ok: false,
      code: aborted
        ? LocalAgentErrorCode.Timeout
        : isNetworkError(err)
          ? LocalAgentErrorCode.Network
          : LocalAgentErrorCode.Unknown,
      message: aborted
        ? "服务生成较慢，请稍候再试"
        : isNetworkError(err)
          ? "无法连接本地服务：请确认 Prompt Boost 本地服务已启动（127.0.0.1:8787）"
          : "本地服务请求失败",
    };
    return network;
  }

  if (!response.ok) {
    let message = `本地服务返回 ${response.status}`;
    let code: LocalAgentFailure["code"] = LocalAgentErrorCode.Http;
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } };
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      // 非 JSON 响应，保持默认消息。
    }
    const failure: LocalAgentFailure = { ok: false, code, message, httpStatus: response.status };
    return failure;
  }

  if (response.status === 204) {
    return { ok: true, data: null as unknown as TData };
  }

  const data = (await response.json()) as TData;
  const result: LocalAgentResult<TData> = { ok: true, data };
  return result;
}

/** /health 请求。 */
export async function pingLocalAgent(options: LocalAgentClientOptions): Promise<LocalAgentResponse<unknown>> {
  return requestLocalAgent<never, unknown>(options, { path: "/health", method: "GET", token: "" });
}
