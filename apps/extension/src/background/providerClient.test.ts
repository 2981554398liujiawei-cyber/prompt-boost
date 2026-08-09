/**
 * providerClient 测试（jsdom）：保存 Provider 时请求体正确性。
 *
 * 回归：修复 B —— PUT /v1/providers/:id 的请求体必须剥离 id（服务端
 * zProviderUpdateRequest 是 strict schema，含 id 会被 zod 拒绝，编辑已有
 * Provider 必失败）。id 已在 URL path 中，body 不应再携带。
 */
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderConfig } from "@prompt-boost/shared";
import { saveProviderToAgent, createProviderToAgent, listModelsFromAgent } from "./providerClient.js";

/** 已保存的本地服务设置（chrome.storage.local 返回）。 */
const SETTINGS = {
  settings: {
    localAgentUrl: "http://127.0.0.1:8787",
    localAgentToken: "local-token",
  },
};

/** mock chrome.storage.local + fetch，返回捕获的请求体与状态码。 */
function mockEnv(
  fetchImpl: (url: string, init: { method?: string; body?: string }) => Promise<Partial<Response>>,
): void {
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async () => SETTINGS,
        set: async () => undefined,
      },
    },
  };
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
  delete (globalThis as { fetch?: unknown }).fetch;
});

const config: ProviderConfig = {
  id: "p-openai",
  name: "我的 OpenAI",
  type: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  timeoutSeconds: 30,
  enabled: true,
};

describe("saveProviderToAgent（PUT）：请求体剥离 id", () => {
  it("编辑已有 Provider 时 body 不含 id（服务端 strict schema 不再 400）", async () => {
    let captured: { url: string; method?: string; body?: string } | undefined;
    mockEnv(async (url, init) => {
      captured = { url, method: init.method, body: init.body };
      return {
        status: 200,
        ok: true,
        json: async () => ({
          provider: { ...config, apiKeyConfigured: true },
        }),
      } as Partial<Response>;
    });

    await saveProviderToAgent(config, "sk-secret-123");

    expect(captured?.method).toBe("PUT");
    expect(captured?.url).toContain("/v1/providers/p-openai");
    const body = JSON.parse(captured?.body ?? "{}") as Record<string, unknown>;
    // 修复 B：id 已由 URL path 承载，body 剥离 id。
    expect(body).not.toHaveProperty("id");
    // 其余配置字段与 apiKey 照常发送（apiKey 走 vault 单独字段）。
    expect(body.name).toBe("我的 OpenAI");
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.apiKey).toBe("sk-secret-123");
  });

  it("PUT 请求体把 apiKey 作为独立字段，不进入 customHeaders/config 结构", async () => {
    let captured: { body?: string } | undefined;
    mockEnv(async (_url, init) => {
      captured = init;
      return {
        status: 200,
        ok: true,
        json: async () => ({ provider: { ...config, apiKeyConfigured: true } }),
      } as Partial<Response>;
    });

    await saveProviderToAgent(config, "sk-secret-123");

    const body = JSON.parse(captured?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({ apiKey: "sk-secret-123", type: "openai", baseUrl: "https://api.openai.com/v1" });
    expect(Object.keys(body)).not.toContain("createdAt");
  });
});

describe("createProviderToAgent（POST）：新建走 config 包裹结构", () => {
  it("POST body 为 { config, apiKey }，config 保留 id", async () => {
    let captured: { method?: string; body?: string } | undefined;
    mockEnv(async (_url, init) => {
      captured = init;
      return {
        status: 200,
        ok: true,
        json: async () => ({ provider: { ...config, apiKeyConfigured: true } }),
      } as Partial<Response>;
    });

    await createProviderToAgent(config, "sk-secret-123");

    expect(captured?.method).toBe("POST");
    const body = JSON.parse(captured?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({ config: { id: "p-openai" }, apiKey: "sk-secret-123" });
  });
});

describe("listModelsFromAgent（POST /v1/providers/models）", () => {
  it("发送 { config, apiKey }，返回模型列表", async () => {
    let captured: { url: string; method?: string; body?: string } | undefined;
    mockEnv(async (url, init) => {
      captured = { url, method: init.method, body: init.body };
      return {
        status: 200,
        ok: true,
        json: async () => ({ providerType: "openai", models: ["gpt-4o", "gpt-4o-mini"] }),
      } as Partial<Response>;
    });

    const result = await listModelsFromAgent(config, "sk-models-456");

    expect(captured?.method).toBe("POST");
    expect(captured?.url).toContain("/v1/providers/models");
    const body = JSON.parse(captured?.body ?? "{}") as Record<string, unknown>;
    expect(body).toMatchObject({ config: { id: "p-openai", model: "gpt-4o-mini" }, apiKey: "sk-models-456" });
    expect(result).toEqual({ providerType: "openai", models: ["gpt-4o", "gpt-4o-mini"] });
  });

  it("apiKey 留空时 body 不含 apiKey（服务端从 Vault 读）", async () => {
    let captured: { body?: string } | undefined;
    mockEnv(async (_url, init) => {
      captured = init;
      return {
        status: 200,
        ok: true,
        json: async () => ({ providerType: "openai", models: ["gpt-4o"] }),
      } as Partial<Response>;
    });

    await listModelsFromAgent(config);
    const body = JSON.parse(captured?.body ?? "{}") as Record<string, unknown>;
    expect(body).not.toHaveProperty("apiKey");
  });

  it("服务端体内 error（如 api_key_missing）→ 抛错展示安全消息", async () => {
    mockEnv(async () => {
      return {
        status: 200,
        ok: true,
        json: async () => ({ providerType: "openai", models: [], error: { code: "api_key_missing", message: "该 Provider 尚未配置 API Key" } }),
      } as Partial<Response>;
    });

    await expect(listModelsFromAgent(config)).rejects.toThrow("该 Provider 尚未配置 API Key");
  });

  it("HTTP 失败 → 标准化为本地服务错误消息", async () => {
    mockEnv(async () => {
      return { status: 502, ok: false, json: async () => ({ error: { code: "http", message: "网关错误" } }) } as Partial<Response>;
    });

    await expect(listModelsFromAgent(config)).rejects.toThrow("网关错误");
  });
});
