/**
 * 本地服务客户端测试（jsdom）。
 * 覆盖：204 空响应不触发 JSON 解析错误；错误响应脱敏标准化。
 */
import { afterEach, describe, expect, it } from "vitest";
import { LocalAgentErrorCode } from "@prompt-boost/shared";
import { clientOptionsFrom, requestLocalAgent } from "./localAgentClient.js";

type FetchImpl = (url: string, init: { method?: string; body?: string }) => Promise<Partial<Response>>;

/** 安装 fetch mock：按调用返回配置好的 Response。 */
function mockFetch(impl: FetchImpl): void {
  globalThis.fetch = impl as unknown as typeof fetch;
}

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe("requestLocalAgent：204 空响应", () => {
  it("DELETE 返回 204 时不解析 JSON，返回 ok:true data:null", async () => {
    mockFetch(async () => ({ status: 204, ok: true } as Response));
    const opts = clientOptionsFrom({ localAgentUrl: "http://127.0.0.1:8787" }, "tok");
    const res = await requestLocalAgent(opts, {
      path: "/v1/providers/abc",
      method: "DELETE",
      token: "tok",
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // 204 无 body：不得调用 response.json()（否则会抛 SyntaxError）。
      expect(res.data).toBeNull();
    }
  });

  it("非 204 空 body 才触发 JSON 解析错误并标准化为 Http 失败", async () => {
    mockFetch(async () => ({ status: 500, ok: false } as Response));
    const opts = clientOptionsFrom({ localAgentUrl: "http://127.0.0.1:8787" }, "tok");
    const res = await requestLocalAgent(opts, {
      path: "/v1/providers/abc",
      method: "DELETE",
      token: "tok",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(LocalAgentErrorCode.Http);
      expect(res.httpStatus).toBe(500);
    }
  });
});

describe("requestLocalAgent：错误标准化", () => {
  it("HTTP 401 携带本地服务错误码与消息", async () => {
    mockFetch(async () => ({
      status: 401,
      ok: false,
      json: async () => ({ error: { code: "unauthorized", message: "令牌无效" } }),
    } as Response));
    const opts = clientOptionsFrom({ localAgentUrl: "http://127.0.0.1:8787" }, "bad");
    const res = await requestLocalAgent(opts, { path: "/health", method: "GET", token: "bad" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("unauthorized");
      expect(res.message).toBe("令牌无效");
    }
  });

  it("网络错误映射为 Network", async () => {
    mockFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    const opts = clientOptionsFrom({ localAgentUrl: "http://127.0.0.1:8787" }, "tok");
    const res = await requestLocalAgent(opts, { path: "/health", method: "GET", token: "tok" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(LocalAgentErrorCode.Network);
    }
  });

  it("AbortError（超时/中止）映射为 Timeout，而非 Network", async () => {
    mockFetch(async () => {
      // AbortSignal.timeout 拒绝时抛出的就是 DOMException（name=TimeoutError）。
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const opts = clientOptionsFrom({ localAgentUrl: "http://127.0.0.1:8787" }, "tok");
    const res = await requestLocalAgent(opts, { path: "/v1/enhance", method: "POST", token: "tok" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(LocalAgentErrorCode.Timeout);
      expect(res.message).toBe("服务生成较慢，请稍候再试");
    }
  });

  it("外部 requestAbortSignal 中止时同样映射为 Timeout", async () => {
    mockFetch(async () => {
      throw new DOMException("The operation was aborted", "AbortError");
    });
    const opts = clientOptionsFrom({ localAgentUrl: "http://127.0.0.1:8787" }, "tok");
    const outer = new AbortController();
    outer.abort();
    const res = await requestLocalAgent(opts, {
      path: "/v1/enhance",
      method: "POST",
      token: "tok",
      timeoutMs: 90_000,
      requestAbortSignal: outer.signal,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe(LocalAgentErrorCode.Timeout);
    }
  });
});
