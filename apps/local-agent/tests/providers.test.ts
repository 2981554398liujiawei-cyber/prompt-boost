/**
 * Provider 核心单测：错误映射 / URL 安全 / 三个 Provider 的成功与失败路径。
 *
 * 绝不调用真实付费 API：全部通过本地 Mock HTTP Server 模拟。
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProviderConfig } from "@prompt-boost/shared";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { createOpenAiCompatibleProvider } from "../src/providers/openai-compatible.js";
import { createOpenAIProvider } from "../src/providers/openai.js";
import { mapNetworkError, mapProviderResponse } from "../src/providers/errors.js";
import { isBlockedAddress, resolveBaseUrl } from "../src/providers/http.js";
import { ProviderError } from "../src/providers/types.js";

interface MockHandler {
  method: string;
  path: string;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  /** 若设置，模拟超时（不响应）。 */
  hang?: boolean;
  /** 模拟网络异常：socket destroy。 */
  destroy?: boolean;
}

function startServer(handlers: MockHandler[]): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handler = handlers.find(
      (h) => h.method === req.method && h.path === url.pathname,
    );
    if (!handler) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (handler.hang) return; // 永不响应 → 触发 AbortSignal.timeout
    if (handler.destroy) {
      res.destroy();
      return;
    }
    res.writeHead(handler.status, {
      "Content-Type": "application/json",
      ...(handler.headers ?? {}),
    });
    res.end(JSON.stringify(handler.body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

function openaiConfig(base: string, overrides?: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: "p-openai",
    name: "OpenAI",
    type: "openai",
    baseUrl: base,
    model: "gpt-4o-mini",
    timeoutSeconds: 5,
    enabled: true,
    ...overrides,
  };
}

function anthropicConfig(base: string): ProviderConfig {
  return {
    id: "p-anthropic",
    name: "Anthropic",
    type: "anthropic",
    baseUrl: base,
    model: "claude-sonnet-5",
    timeoutSeconds: 5,
    enabled: true,
  };
}

function compatConfig(base: string): ProviderConfig {
  return {
    id: "p-compat",
    name: "Compat",
    type: "openai-compatible",
    baseUrl: base,
    model: "some-model",
    timeoutSeconds: 5,
    enabled: true,
  };
}

function compatConfigNoBase(): ProviderConfig {
  return {
    id: "p-compat",
    name: "Compat",
    type: "openai-compatible",
    baseUrl: undefined,
    model: "some-model",
    timeoutSeconds: 5,
    enabled: true,
  };
}

const servers: Server[] = [];

beforeAll(() => {
  // 清理全局 fetch 缓存无关项；无操作。
});

afterAll(() => {
  for (const s of servers) s.close();
});

describe("resolveBaseUrl 安全校验", () => {
  it("拒绝 http:// 非本机地址", () => {
    expect(() => resolveBaseUrl("openai", "http://api.example.com/v1")).toThrow(
      ProviderError,
    );
  });

  it("允许 http://localhost 与 127.0.0.1", () => {
    expect(resolveBaseUrl("openai", "http://localhost:1234/v1")).toBe(
      "http://localhost:1234/v1",
    );
    expect(resolveBaseUrl("openai", "http://127.0.0.1:1234/v1")).toBe(
      "http://127.0.0.1:1234/v1",
    );
  });

  it("拒绝私网地址（内网探测防护）", () => {
    expect(() => resolveBaseUrl("openai", "http://10.0.0.5/v1")).toThrow(ProviderError);
    expect(() => resolveBaseUrl("openai", "http://192.168.1.1/v1")).toThrow(ProviderError);
    expect(() => resolveBaseUrl("openai", "https://172.16.0.1/v1")).toThrow(ProviderError);
    // new URL 会把点分 mapped IPv4 规范化为 hex；字面量通常不会经过 DNS lookup。
    expect(() =>
      resolveBaseUrl("openai", "https://[::ffff:127.0.0.1]/v1"),
    ).toThrow(ProviderError);
    expect(() =>
      resolveBaseUrl("openai", "https://[::ffff:10.0.0.1]/v1"),
    ).toThrow(ProviderError);
  });

  it("拒绝非 https 协议", () => {
    expect(() => resolveBaseUrl("openai", "ftp://api.example.com/v1")).toThrow(ProviderError);
  });

  it("拒绝无效 URL", () => {
    expect(() => resolveBaseUrl("openai", "not-a-url")).toThrow(ProviderError);
  });

  it("规范化尾部斜杠", () => {
    expect(resolveBaseUrl("openai", "https://api.openai.com/v1/")).toBe(
      "https://api.openai.com/v1",
    );
  });
});

describe("isBlockedAddress 地址归类", () => {
  it.each([
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.10.20",
    "::ffff:172.16.0.1",
    "::ffff:192.168.1.1",
    "::ffff:7f00:1",
    "::ffff:a00:1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
  ])("拒绝 IPv4-mapped IPv6 与 IPv6 私网/保留地址：%s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])(
    "允许公网地址：%s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe("mapProviderResponse 错误映射", () => {
  it("401 → INVALID_API_KEY", () => {
    const err = mapProviderResponse("openai", 401, JSON.stringify({ error: {} }));
    expect(err?.code).toBe("INVALID_API_KEY");
    expect(err?.retryable).toBe(false);
  });

  it("403 且 type=rate_limit_error → RATE_LIMITED", () => {
    const err = mapProviderResponse(
      "openai",
      403,
      JSON.stringify({ error: { type: "rate_limit_error" } }),
    );
    expect(err?.code).toBe("RATE_LIMITED");
    expect(err?.retryable).toBe(true);
  });

  it("403 且 type=insufficient_quota → INSUFFICIENT_QUOTA", () => {
    const err = mapProviderResponse(
      "openai",
      403,
      JSON.stringify({ error: { type: "insufficient_quota" } }),
    );
    expect(err?.code).toBe("INSUFFICIENT_QUOTA");
    expect(err?.retryable).toBe(false);
  });

  it("404 → MODEL_NOT_FOUND", () => {
    const err = mapProviderResponse("openai", 404, "{}");
    expect(err?.code).toBe("MODEL_NOT_FOUND");
  });

  it("429 → RATE_LIMITED", () => {
    const err = mapProviderResponse("openai", 429, "{}");
    expect(err?.code).toBe("RATE_LIMITED");
    expect(err?.retryable).toBe(true);
  });

  it("400 → INVALID_REQUEST", () => {
    const err = mapProviderResponse("anthropic", 400, "{}");
    expect(err?.code).toBe("INVALID_REQUEST");
  });

  it("500 → PROVIDER_UNAVAILABLE", () => {
    const err = mapProviderResponse("openai", 500, "{}");
    expect(err?.code).toBe("PROVIDER_UNAVAILABLE");
  });

  it("2xx → null（成功）", () => {
    expect(mapProviderResponse("openai", 200, "{}")).toBeNull();
  });
});

describe("Provider 重定向安全", () => {
  it("不跟随 Chat API 的 302 跳转", async () => {
    const target = await startServer([
      {
        method: "POST",
        path: "/chat/completions",
        status: 200,
        body: { choices: [{ message: { content: "pong" } }] },
      },
    ]);
    const source = await startServer([
      {
        method: "POST",
        path: "/chat/completions",
        status: 302,
        headers: { Location: `${target.base}/chat/completions` },
        body: {},
      },
    ]);
    servers.push(target.server, source.server);
    const provider = createOpenAiCompatibleProvider({
      // 使用 hostname 而非 IP，覆盖 undici lookup(all:true) 地址数组分支。
      config: compatConfig(source.base.replace("127.0.0.1", "localhost")),
      apiKey: "k",
    });
    const result = await provider.testConnection();
    expect(result.success).toBe(false);
  });
});

describe("mapNetworkError 网络错误映射", () => {
  it("AbortError → TIMEOUT", () => {
    const err = mapNetworkError("openai", new DOMException("aborted", "AbortError"));
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
  });

  it("TimeoutError（Node AbortSignal.timeout）→ TIMEOUT", () => {
    const err = mapNetworkError(
      "openai",
      new Error("The operation was aborted due to timeout"),
    );
    err.name = "TimeoutError";
    expect(err.code).toBe("TIMEOUT");
    expect(err.retryable).toBe(true);
  });

  it("ECONNREFUSED → CONNECTION_FAILED", () => {
    const err = mapNetworkError("openai", new Error("connect ECONNREFUSED 127.0.0.1:1"));
    expect(err.code).toBe("CONNECTION_FAILED");
  });

  it("fetch failed → CONNECTION_FAILED", () => {
    const err = mapNetworkError("openai", new TypeError("fetch failed"));
    expect(err.code).toBe("CONNECTION_FAILED");
  });
});

describe("OpenAIProvider.testConnection", () => {
  it("缺 model → INVALID_REQUEST（不静默选择默认模型）", () => {
    expect(() =>
      createOpenAIProvider({
        config: { ...openaiConfig("http://127.0.0.1:9"), model: "" },
        apiKey: "k",
      }),
    ).toThrow(ProviderError);
  });
  it("GET /models 成功 → success=true", async () => {
    const { server, base } = await startServer([
      { method: "GET", path: "/models", status: 200, body: { data: [{ id: "gpt-4o-mini" }] } },
    ]);
    servers.push(server);
    const provider = createOpenAIProvider({
      config: openaiConfig(base),
      apiKey: "sk-test",
    });
    const r = await provider.testConnection();
    expect(r.success).toBe(true);
    expect(r.providerType).toBe("openai");
    expect(r.model).toBe("gpt-4o-mini");
    expect(typeof r.latencyMs).toBe("number");
    expect(r.error).toBeNull();
  });

  it("401 → INVALID_API_KEY，且 safeMessage 不含 Key", async () => {
    const { server, base } = await startServer([
      { method: "GET", path: "/models", status: 401, body: { error: { message: "Incorrect API key provided: sk-secret" } } },
    ]);
    servers.push(server);
    const provider = createOpenAIProvider({
      config: openaiConfig(base),
      apiKey: "sk-secret",
    });
    const r = await provider.testConnection();
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe("INVALID_API_KEY");
    expect(r.error?.message).not.toContain("sk-secret");
    expect(r.error?.message).not.toContain("Incorrect API key");
  });

  it("429 → RATE_LIMITED", async () => {
    const { server, base } = await startServer([
      { method: "GET", path: "/models", status: 429, body: { error: { type: "rate_limit_error" } } },
    ]);
    servers.push(server);
    const provider = createOpenAIProvider({ config: openaiConfig(base), apiKey: "k" });
    const r = await provider.testConnection();
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe("RATE_LIMITED");
  });

  it("404（网关禁用 /models）→ 回退 chat 请求成功", async () => {
    const { server, base } = await startServer([
      { method: "GET", path: "/models", status: 404, body: { error: "no models" } },
      {
        method: "POST",
        path: "/chat/completions",
        status: 200,
        body: { choices: [{ message: { content: "pong" } }] },
      },
    ]);
    servers.push(server);
    const provider = createOpenAIProvider({ config: openaiConfig(base), apiKey: "k" });
    const r = await provider.testConnection();
    expect(r.success).toBe(true);
  });

  it("超时（服务器挂起）→ TIMEOUT", async () => {
    const { server, base } = await startServer([
      { method: "GET", path: "/models", status: 200, body: {}, hang: true },
    ]);
    servers.push(server);
    const provider = createOpenAIProvider({
      config: openaiConfig(base, { timeoutSeconds: 1 }),
      apiKey: "k",
    });
    const r = await provider.testConnection();
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe("TIMEOUT");
  }, 10_000);

  it("网络拒绝连接 → CONNECTION_FAILED", async () => {
    const provider = createOpenAIProvider({
      config: openaiConfig("http://127.0.0.1:1", { timeoutSeconds: 1 }),
      apiKey: "k",
    });
    const r = await provider.testConnection();
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe("CONNECTION_FAILED");
  });

  it("非 JSON 响应 → RESPONSE_INVALID", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("not json");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const provider = createOpenAIProvider({
      config: openaiConfig(`http://127.0.0.1:${port}`),
      apiKey: "k",
    });
    const r = await provider.testConnection();
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe("RESPONSE_INVALID");
  });
});

describe("AnthropicProvider.testConnection", () => {
  it("缺 model → INVALID_REQUEST（不静默选择默认模型）", () => {
    expect(() =>
      createAnthropicProvider({
        config: { ...anthropicConfig("http://127.0.0.1:9"), model: "" },
        apiKey: "k",
      }),
    ).toThrow(ProviderError);
  });
  it("成功（含 content blocks）→ success=true", async () => {
    const { server, base } = await startServer([
      {
        method: "POST",
        path: "/messages",
        status: 200,
        body: { content: [{ type: "text", text: "pong" }], stop_reason: "end_turn" },
      },
    ]);
    servers.push(server);
    const provider = createAnthropicProvider({
      config: anthropicConfig(base),
      apiKey: "sk-ant-test",
    });
    const r = await provider.testConnection();
    expect(r.success).toBe(true);
    expect(r.providerType).toBe("anthropic");
  });

  it("空内容且异常 stop_reason → RESPONSE_INVALID", async () => {
    const { server, base } = await startServer([
      { method: "POST", path: "/messages", status: 200, body: { content: [], stop_reason: "stop" } },
    ]);
    servers.push(server);
    const provider = createAnthropicProvider({
      config: anthropicConfig(base),
      apiKey: "k",
    });
    const r = await provider.testConnection();
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe("RESPONSE_INVALID");
  });

  it("401 → INVALID_API_KEY", async () => {
    const { server, base } = await startServer([
      { method: "POST", path: "/messages", status: 401, body: { error: { type: "authentication_error" } } },
    ]);
    servers.push(server);
    const provider = createAnthropicProvider({ config: anthropicConfig(base), apiKey: "bad" });
    const r = await provider.testConnection();
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe("INVALID_API_KEY");
  });
});

describe("AnthropicProvider.enhancePrompt（修复：绝不注入 response_format）", () => {
  /** 捕获请求体并返回单个 text block 的 mock server。 */
  async function captureMessagesServer(): Promise<{ base: string; body: Promise<string> }> {
    let resolveBody!: (v: string) => void;
    const body = new Promise<string>((r) => (resolveBody = r));
    const server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        resolveBody(b);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            content: [{ type: "text", text: '{"enhancedText":"增强后的内容","reasoning":"r","assumptions":[],"originalIntent":"i","detectedTaskType":"business","scoreDimensions":{"objective":80,"context":70,"audience":60,"outputFormat":85,"constraints":50,"role":75,"materials":40,"actionability":70},"missingInformation":[],"suggestions":[],"confidence":0.9}' }],
            stop_reason: "end_turn",
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, body };
  }

  const enhanceArgs = {
    systemPrompt: "system 元提示",
    userPrompt: "user 提示",
    originalText: "写产品推广方案",
    taskType: "auto" as const,
    enhanceLevel: "deep" as const,
    clarificationMode: "smart" as const,
  };

  it("请求体不含 response_format（Anthropic 不识别该字段，注入会 400）", async () => {
    const cap = await captureMessagesServer();
    const provider = createAnthropicProvider({ config: anthropicConfig(cap.base), apiKey: "k" });
    const result = await provider.enhancePrompt(enhanceArgs);
    expect(result.enhancedText).toContain("增强后的内容");
    const body = await cap.body;
    expect(body).not.toContain("response_format");
    expect(body).not.toContain("json_object");
    // system 走 Anthropic 独立字段，messages 只有 user 轮。
    expect(body).toContain('"system"');
    expect(body).toContain("system 元提示");
    expect(body).toContain("user 提示");
    expect(body).toContain("claude-sonnet-5");
    expect(body).not.toContain("sk-");
  });

  it("显式 jsonMode:false 返回纯文本（不按 JSON 解析、不注入、不抛错）", async () => {
    const cap = await captureMessagesServer();
    const provider = createAnthropicProvider({ config: anthropicConfig(cap.base), apiKey: "k" });
    const result = await provider.enhancePrompt(enhanceArgs, { jsonMode: false });
    // 修复 C 补全：jsonMode=false 时纯文本直接作为增强结果（不尝试 JSON 解析，
    // 否则纯文本会被误判 RESPONSE_INVALID）。mock 返回的是 JSON 文本，因此
    // enhancedText 就是这段原始文本，analysis 为 null。
    expect(result.enhancedText).toContain('"enhancedText"');
    expect(result.enhancedText).toContain("增强后的内容");
    expect(result.analysis).toBeNull();
    expect(await cap.body).not.toContain("response_format");
  });
});

describe("Provider 请求超时与断连 signal 合并（修复 F）", () => {
  it("无断连 signal 时 Provider 超时仍生效（服务器挂起 → TIMEOUT）", async () => {
    const { server, base } = await startServer([{ method: "POST", path: "/chat/completions", status: 200, body: {}, hang: true }]);
    servers.push(server);
    const provider = createOpenAiCompatibleProvider({
      config: { ...compatConfig(base), timeoutSeconds: 1 },
      apiKey: "k",
    });
    await expect(
      provider.enhancePrompt({
        systemPrompt: "s",
        userPrompt: "u",
        originalText: "写产品推广方案",
        taskType: "auto",
        enhanceLevel: "deep",
        clarificationMode: "smart",
      }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("有断连 signal 时 Provider 超时仍生效（不再被 outer signal 架空）", async () => {
    const { server, base } = await startServer([{ method: "POST", path: "/chat/completions", status: 200, body: {}, hang: true }]);
    servers.push(server);
    const provider = createOpenAiCompatibleProvider({
      config: { ...compatConfig(base), timeoutSeconds: 1 },
      apiKey: "k",
    });
    // 外层断连 signal 恒存在（模拟 app.ts 的 AbortController），但 inner timeout 必须仍触发。
    const outer = new AbortController();
    await expect(
      provider.enhancePrompt(
        {
          systemPrompt: "s",
          userPrompt: "u",
          originalText: "写产品推广方案",
          taskType: "auto",
          enhanceLevel: "deep",
          clarificationMode: "smart",
        },
        { signal: outer.signal },
      ),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("外层断连 signal 触发时中止（孤儿请求清理）", async () => {
    const { server, base } = await startServer([{ method: "POST", path: "/chat/completions", status: 200, body: {}, hang: true }]);
    servers.push(server);
    const provider = createOpenAiCompatibleProvider({
      config: { ...compatConfig(base), timeoutSeconds: 30 },
      apiKey: "k",
    });
    const outer = new AbortController();
    const pending = provider.enhancePrompt(
      {
        systemPrompt: "s",
        userPrompt: "u",
        originalText: "写产品推广方案",
        taskType: "auto",
        enhanceLevel: "deep",
        clarificationMode: "smart",
      },
      { signal: outer.signal },
    );
    setTimeout(() => outer.abort(), 50);
    await expect(pending).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("OpenAiCompatibleProvider.testConnection", () => {
  it("缺 Base URL → INVALID_REQUEST", () => {
    expect(() =>
      createOpenAiCompatibleProvider({
        config: compatConfigNoBase(),
        apiKey: "k",
      }),
    ).toThrow(ProviderError);
  });

  it("缺 model → INVALID_REQUEST（不自动猜测模型）", () => {
    expect(() =>
      createOpenAiCompatibleProvider({
        config: { ...compatConfig("http://127.0.0.1:9"), model: "" },
        apiKey: "k",
      }),
    ).toThrow(ProviderError);
  });

  it("成功 → success=true", async () => {
    const { server, base } = await startServer([
      { method: "POST", path: "/chat/completions", status: 200, body: { choices: [{ message: { content: "pong" } }] } },
    ]);
    servers.push(server);
    const provider = createOpenAiCompatibleProvider({ config: compatConfig(base), apiKey: "k" });
    const r = await provider.testConnection();
    expect(r.success).toBe(true);
    expect(r.providerType).toBe("openai-compatible");
  });

  it("推理模型：content 为空但 reasoning_content 有内容 → success=true", async () => {
    const { server, base } = await startServer([
      {
        method: "POST",
        path: "/chat/completions",
        status: 200,
        body: { choices: [{ message: { content: "", reasoning_content: "Let me think about ping → pong" } }] },
      },
    ]);
    servers.push(server);
    const provider = createOpenAiCompatibleProvider({ config: compatConfig(base), apiKey: "k" });
    const r = await provider.testConnection();
    expect(r.success).toBe(true);
  });

  it("响应缺少 choices/message/content → RESPONSE_INVALID", async () => {
    const { server, base } = await startServer([
      { method: "POST", path: "/chat/completions", status: 200, body: {} },
    ]);
    servers.push(server);
    const provider = createOpenAiCompatibleProvider({ config: compatConfig(base), apiKey: "k" });
    const r = await provider.testConnection();
    expect(r.success).toBe(false);
    expect(r.error?.code).toBe("RESPONSE_INVALID");
  });
});

describe("openai-compatible enhancePrompt（阶段 5 单次调用）", () => {
  /** 启动可捕获请求体并返回固定响应的 mock server；返回即已监听，body/auth 在请求到达时 resolve。 */
  async function captureServer(
    responseBody: unknown,
  ): Promise<{ base: string; body: Promise<string>; auth: Promise<string> }> {
    let resolveBody!: (v: string) => void;
    let resolveAuth!: (v: string) => void;
    const body = new Promise<string>((r) => (resolveBody = r));
    const auth = new Promise<string>((r) => (resolveAuth = r));
    const server = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        resolveBody(b);
        resolveAuth(req.headers.authorization ?? "");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, body, auth };
  }

  const ENHANCE_JSON = {
    enhancedText: "请为公司新产品撰写推广方案，明确目标受众与投放渠道。",
    reasoning: "补充背景与受众",
    assumptions: ["假设为新产品"],
    originalIntent: "写产品推广方案",
    detectedTaskType: "business",
    scoreDimensions: { objective: 85, context: 70, audience: 60, outputFormat: 80, constraints: 50, role: 75, materials: 40, actionability: 70 },
    missingInformation: ["预算"],
    suggestions: ["补充预算范围"],
    confidence: 0.9,
  };

  it("单块 JSON 输出解析为增强结果；兼容层不发送 response_format，默认不发送 thinking", async () => {
    const cap = await captureServer({ choices: [{ message: { content: JSON.stringify(ENHANCE_JSON) } }] });
    const provider = createOpenAiCompatibleProvider({
      config: { ...compatConfig(cap.base), timeoutSeconds: 5, disableThinking: false },
      apiKey: "sk-secret-123456",
    });

    const result = await provider.enhancePrompt({
      systemPrompt: "system 元提示",
      userPrompt: "user 提示",
      originalText: "写产品推广方案",
      taskType: "auto",
      enhanceLevel: "deep",
      clarificationMode: "smart",
    });

    // 解析成功，拿到增强后 Prompt 与分析字段。
    expect(result.enhancedText).toBe(ENHANCE_JSON.enhancedText);
    expect(result.analysis.scoreSource).toBe("llm");
    expect(result.analysis.scoreDimensions.objective).toBe(85);
    expect(result.analysis.missingInformation).toEqual(["预算"]);
    expect(result.assumptions).toEqual(["假设为新产品"]);

    const body = await cap.body;
    const auth = await cap.auth;
    // 兼容层只发送基础字段；结构化输出由提示词约束，避免网关不支持扩展字段。
    expect(body).toContain("system 元提示");
    expect(body).toContain("user 提示");
    expect(body).not.toContain('"response_format"');
    expect(body).not.toContain("json_object");
    expect(body).not.toContain('"thinking"');
    expect(body).not.toContain("sk-secret-123456");
    // Key 只出现在 Authorization 头。
    expect(auth).toBe("Bearer sk-secret-123456");
  });

  it("disableThinking=true 时发送 DeepSeek 非思考模式字段", async () => {
    const cap = await captureServer({
      choices: [{ message: { content: JSON.stringify(ENHANCE_JSON) } }],
    });
    const provider = createOpenAiCompatibleProvider({
      config: { ...compatConfig(cap.base), disableThinking: true },
      apiKey: "k",
    });

    await provider.enhancePrompt({
      systemPrompt: "s",
      userPrompt: "u",
      originalText: "写产品推广方案",
      taskType: "auto",
      enhanceLevel: "deep",
      clarificationMode: "smart",
    });

    const body = JSON.parse(await cap.body) as Record<string, unknown>;
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("response_format");
  });

  it("非 JSON 内容 → RESPONSE_INVALID（供 pipeline 触发文本降级）", async () => {
    const cap = await captureServer({
      choices: [{ message: { content: "这不是 JSON，模型直接回答任务了。" } }],
    });
    const provider = createOpenAiCompatibleProvider({
      config: { ...compatConfig(cap.base), timeoutSeconds: 5 },
      apiKey: "k",
    });

    await expect(
      provider.enhancePrompt({
        systemPrompt: "s",
        userPrompt: "u",
        originalText: "写产品推广方案",
        taskType: "auto",
        enhanceLevel: "deep",
        clarificationMode: "smart",
      }),
    ).rejects.toMatchObject({ code: "RESPONSE_INVALID" });
    expect(await cap.body).not.toContain("sk-secret");
  });

  it("推理模型：JSON 放在 reasoning_content（content 为空）也能解析", async () => {
    const cap = await captureServer({
      choices: [{ message: { content: "", reasoning_content: JSON.stringify(ENHANCE_JSON) } }],
    });
    const provider = createOpenAiCompatibleProvider({
      config: { ...compatConfig(cap.base), timeoutSeconds: 5 },
      apiKey: "sk-secret-123456",
    });

    const result = await provider.enhancePrompt({
      systemPrompt: "s",
      userPrompt: "u",
      originalText: "写产品推广方案",
      taskType: "auto",
      enhanceLevel: "deep",
      clarificationMode: "smart",
    });
    expect(result.enhancedText).toBe(ENHANCE_JSON.enhancedText);
    expect(result.analysis.scoreSource).toBe("llm");
  });
});

describe("ModelProvider.listModels（拉取可用模型列表）", () => {
  it("OpenAI：GET /models → 返回 data[].id，去重", async () => {
    const { server, base } = await startServer([
      {
        method: "GET",
        path: "/models",
        status: 200,
        body: { data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "gpt-4o-mini" }] },
      },
    ]);
    servers.push(server);
    const provider = createOpenAIProvider({ config: openaiConfig(base), apiKey: "sk-test" });
    const models = await provider.listModels();
    expect(models).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("OpenAI：401 → 抛 ProviderError（INVALID_API_KEY），safeMessage 不含 Key", async () => {
    const { server, base } = await startServer([
      { method: "GET", path: "/models", status: 401, body: { error: { message: "Bad key: sk-secret" } } },
    ]);
    servers.push(server);
    const provider = createOpenAIProvider({ config: openaiConfig(base), apiKey: "sk-secret" });
    await expect(provider.listModels()).rejects.toMatchObject({
      code: "INVALID_API_KEY",
    });
  });

  it("Anthropic：GET /models → 返回 data[].id", async () => {
    const { server, base } = await startServer([
      { method: "GET", path: "/models", status: 200, body: { data: [{ id: "claude-sonnet-5" }, { id: "claude-haiku-4-5" }] } },
    ]);
    servers.push(server);
    const provider = createAnthropicProvider({ config: anthropicConfig(base), apiKey: "sk-ant-test" });
    const models = await provider.listModels();
    expect(models).toEqual(["claude-sonnet-5", "claude-haiku-4-5"]);
  });

  it("Anthropic：请求头带 x-api-key 与 anthropic-version", async () => {
    let seenHeaders: Record<string, string | undefined> = {};
    const server = createServer((req, res) => {
      seenHeaders = req.headers as Record<string, string | undefined>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "claude-sonnet-5" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    const provider = createAnthropicProvider({
      config: anthropicConfig(`http://127.0.0.1:${port}`),
      apiKey: "sk-ant-header-check",
    });
    await provider.listModels();
    expect(seenHeaders["x-api-key"]).toBe("sk-ant-header-check");
    expect(seenHeaders["anthropic-version"]).toBe("2023-06-01");
  });

  it("openai-compatible：GET /models → 返回 data[].id", async () => {
    const { server, base } = await startServer([
      { method: "GET", path: "/models", status: 200, body: { data: [{ id: "qwen-max" }, { id: "qwen-turbo" }] } },
    ]);
    servers.push(server);
    const provider = createOpenAiCompatibleProvider({ config: compatConfig(base), apiKey: "k" });
    const models = await provider.listModels();
    expect(models).toEqual(["qwen-max", "qwen-turbo"]);
  });

  it("openai-compatible：网关禁用 /models（404）→ 抛 ProviderError", async () => {
    const { server, base } = await startServer([
      { method: "GET", path: "/models", status: 404, body: { error: "not implemented" } },
    ]);
    servers.push(server);
    const provider = createOpenAiCompatibleProvider({ config: compatConfig(base), apiKey: "k" });
    await expect(provider.listModels()).rejects.toMatchObject({
      code: "MODEL_NOT_FOUND",
    });
  });

  it("非数组 data（空对象）→ 返回空数组而非抛错", async () => {
    const { server, base } = await startServer([
      { method: "GET", path: "/models", status: 200, body: { object: "list" } },
    ]);
    servers.push(server);
    const provider = createOpenAIProvider({ config: openaiConfig(base), apiKey: "k" });
    const models = await provider.listModels();
    expect(models).toEqual([]);
  });
});
