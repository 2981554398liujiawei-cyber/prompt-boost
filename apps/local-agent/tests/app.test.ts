// 路径隔离副作用必须先于任何 src 模块的静态导入执行（ESM 提升）。
import "./paths-env.js";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/db.js";
import { createVault } from "../src/security/vault.js";
import { createApp } from "../src/app.js";
import { createPromptEngine } from "../src/prompt-engine/prompt-engine.js";

const TOKEN = "test-token-0123456789abcdef";

// 每个用例用独立临时 DB 文件；vault / token 全部落在临时目录。
afterAll(() => {
  delete process.env.LOCAL_AGENT_DATA_DIR;
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pb-agent-db-"));
  const db = openDatabase(join(dir, "test.db"));
  return { dir, db };
}

/** 启动一个本地 Mock HTTP Server，按路径返回预设响应。 */
function startMockServer(handlers: Array<{ method: string; url: string; status: number; body: unknown }>): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const handler = handlers.find(
      (h) => h.method === req.method && h.url === req.url,
    );
    if (!handler) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "mock not found" }));
      return;
    }
    res.writeHead(handler.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(handler.body));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
      }
    });
  });
}

describe("local-agent app", () => {
  let db: ReturnType<typeof openDatabase>;
  let vault: Awaited<ReturnType<typeof createVault>>;
  let app: ReturnType<typeof createApp>;

  beforeEach(async () => {
    const s = setup();
    db = s.db;
    vault = await createVault();
    app = createApp({
      db,
      vault,
      authToken: TOKEN,
      version: "0.1.0-test",
      promptEngine: createPromptEngine(db, vault),
    });
  });

  afterEach(() => {
    db.close();
  });

  it("GET /health 返回 ok", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("prompt-boost-local-agent");
    expect(res.body.version).toBe("0.1.0-test");
    expect(typeof res.body.time).toBe("number");
  });

  it("未授权请求 /v1/* 返回 401", async () => {
    await request(app).get("/v1/settings").expect(401);
    await request(app).get("/v1/providers").expect(401);
  });

  it("错误令牌返回 401", async () => {
    await request(app)
      .get("/v1/settings")
      .set("Authorization", "Bearer wrong-token")
      .expect(401);
  });

  it("携带正确令牌可访问 /v1/settings", async () => {
    const res = await request(app)
      .get("/v1/settings")
      .set("Authorization", `Bearer ${TOKEN}`)
      .expect(200);
    expect(res.body.settings.enhanceLevel).toBe("deep");
    expect(res.body.settings.clarificationMode).toBe("smart");
  });

  it("PUT /v1/settings 更新并持久化", async () => {
    const res = await request(app)
      .put("/v1/settings")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ enhanceLevel: "expert" })
      .expect(200);
    expect(res.body.settings.enhanceLevel).toBe("expert");
    const res2 = await request(app)
      .get("/v1/settings")
      .set("Authorization", `Bearer ${TOKEN}`)
      .expect(200);
    expect(res2.body.settings.enhanceLevel).toBe("expert");
  });

  it("PUT /v1/settings 拒绝非法枚举", async () => {
    await request(app)
      .put("/v1/settings")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ enhanceLevel: "ultra" })
      .expect(400);
  });

  it("POST /v1/providers 保存配置并入库", async () => {
    await request(app)
      .post("/v1/providers")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        config: {
          id: "openai-main",
          type: "openai",
          name: "我的 OpenAI",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          timeoutSeconds: 30,
        },
      })
      .expect(201);

    const res = await request(app)
      .get("/v1/providers")
      .set("Authorization", `Bearer ${TOKEN}`)
      .expect(200);
    expect(res.body.providers).toHaveLength(1);
    expect(res.body.providers[0].model).toBe("gpt-4o-mini");
  });

  it("POST /v1/providers 敏感请求头值不回显（脱敏为 ***）", async () => {
    await request(app)
      .post("/v1/providers")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        config: {
          id: "gw",
          type: "openai-compatible",
          name: "网关",
          baseUrl: "http://127.0.0.1:8787",
          model: "some-model",
          timeoutSeconds: 30,
          customHeaders: {
            Authorization: "Bearer sk-gateway-secret-456",
            "x-api-key": "sk-x-789",
            "X-Custom": "normal-value",
          },
        },
        apiKey: "sk-main-secret-123",
      })
      .expect(201);

    const list = await request(app)
      .get("/v1/providers")
      .set("Authorization", `Bearer ${TOKEN}`)
      .expect(200);
    const gw = list.body.providers.find((p: { id: string }) => p.id === "gw");
    // 修复 J：敏感头值脱敏，绝不回显完整值；非敏感头原样。
    expect(gw.customHeaders.Authorization).toBe("***");
    expect(gw.customHeaders["x-api-key"]).toBe("***");
    expect(gw.customHeaders["X-Custom"]).toBe("normal-value");
    // 完整 Key / 敏感值不得出现在响应中。
    expect(JSON.stringify(list.body)).not.toContain("sk-gateway-secret");
    expect(JSON.stringify(list.body)).not.toContain("sk-x-789");
    expect(JSON.stringify(list.body)).not.toContain("sk-main-secret");

    // 单条 GET 同样脱敏。
    const one = await request(app)
      .get("/v1/providers/gw")
      .set("Authorization", `Bearer ${TOKEN}`)
      .expect(200);
    expect(one.body.provider.customHeaders.Authorization).toBe("***");
    expect(JSON.stringify(one.body)).not.toContain("sk-gateway-secret");

    // SQLite 只保存掩码与非敏感值，真实敏感值只进入 Vault。
    const stored = db.getProvider("gw");
    expect(JSON.parse(stored?.custom_headers_json ?? "{}")).toEqual({
      Authorization: "***",
      "x-api-key": "***",
      "X-Custom": "normal-value",
    });
    expect(stored?.custom_headers_json).not.toContain("sk-gateway-secret-456");
    expect(stored?.custom_headers_json).not.toContain("sk-x-789");
    expect(JSON.parse((await vault.getSecret("providerHeaders:gw")) ?? "{}")).toEqual({
      Authorization: "Bearer sk-gateway-secret-456",
      "x-api-key": "sk-x-789",
    });

    // 编辑页回传 *** 时必须保留 Vault 中的原值，不能把掩码当成新密钥覆盖。
    await request(app)
      .put("/v1/providers/gw")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        name: "网关（已编辑）",
        customHeaders: {
          Authorization: "***",
          "x-api-key": "***",
          "X-Custom": "changed-value",
        },
      })
      .expect(200);

    expect(JSON.parse((await vault.getSecret("providerHeaders:gw")) ?? "{}")).toEqual({
      Authorization: "Bearer sk-gateway-secret-456",
      "x-api-key": "sk-x-789",
    });
    expect(JSON.parse(db.getProvider("gw")?.custom_headers_json ?? "{}")).toEqual({
      Authorization: "***",
      "x-api-key": "***",
      "X-Custom": "changed-value",
    });
  });

  it("Provider 异步路由 rejection 返回 500 且不产生 unhandledRejection", async () => {
    db.upsertProvider({
      id: "rejecting-provider",
      type: "openai",
      name: "Rejecting",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      timeoutSeconds: 30,
      enabled: true,
    });
    const rejection = new Error("synthetic vault rejection");
    const rejectingVault: typeof vault = {
      ...vault,
      getSecret: async () => Promise.reject(rejection),
    };
    const quietLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    };
    const rejectionApp = createApp({
      db,
      vault: rejectingVault,
      authToken: TOKEN,
      version: "0.1.0-test",
      logger: quietLogger,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const res = await request(rejectionApp)
        .get("/v1/providers")
        .set("Authorization", `Bearer ${TOKEN}`)
        .expect(500);
      expect(res.body.error.code).toBe("internal");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("POST /v1/providers 拒绝非法 URL", async () => {
    await request(app)
      .post("/v1/providers")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        config: {
          id: "bad",
          type: "openai",
          name: "坏配置",
          baseUrl: "not-a-url",
          model: "x",
          timeoutSeconds: 30,
        },
      })
      .expect(400);
  });

  it("POST /v1/providers/test 通过 Mock 服务器验证连接成功映射", async () => {
    const mock = await startMockServer([
      { method: "GET", url: "/models", status: 200, body: { data: [{ id: "gpt-4o-mini" }] } },
    ]);
    try {
      const res = await request(app)
        .post("/v1/providers/test")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({
          config: {
            id: "mock-openai",
            type: "openai",
            name: "Mock OpenAI",
            baseUrl: mock.baseUrl,
            model: "gpt-4o-mini",
            timeoutSeconds: 30,
          },
          apiKey: "sk-test-0123456789abcdef",
        })
        .expect(200);
      expect(res.body.success).toBe(true);
      expect(res.body.providerId).toBe("mock-openai");
      expect(res.body.providerType).toBe("openai");
      expect(res.body.model).toBe("gpt-4o-mini");
      expect(typeof res.body.latencyMs).toBe("number");
      expect(typeof res.body.checkedAt).toBe("string");
      expect(res.body.error).toBeNull();
      // API Key 不出现在响应中。
      expect(JSON.stringify(res.body)).not.toContain("sk-test");
    } finally {
      mock.server.close();
    }
  });

  it("POST /v1/providers/test 401 映射为 INVALID_API_KEY 且不泄露响应体", async () => {
    const mock = await startMockServer([
      { method: "GET", url: "/models", status: 401, body: { error: { message: "Incorrect API key provided: sk-abc", type: "invalid_request_error" } } },
    ]);
    try {
      const res = await request(app)
        .post("/v1/providers/test")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({
          config: {
            id: "mock-openai",
            type: "openai",
            name: "Mock OpenAI",
            baseUrl: mock.baseUrl,
            model: "gpt-4o-mini",
            timeoutSeconds: 30,
          },
          apiKey: "sk-bad",
        })
        .expect(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("INVALID_API_KEY");
      // 不泄露 Provider 响应体中的原始错误。
      expect(JSON.stringify(res.body)).not.toContain("Incorrect API key");
      expect(JSON.stringify(res.body)).not.toContain("sk-abc");
    } finally {
      mock.server.close();
    }
  });

  it("POST /v1/providers/test 429 映射为 RATE_LIMITED（可重试）", async () => {
    const mock = await startMockServer([
      { method: "GET", url: "/models", status: 429, body: { error: { message: "Rate limit reached", type: "rate_limit_error" } } },
    ]);
    try {
      const res = await request(app)
        .post("/v1/providers/test")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({
          config: {
            id: "mock-openai",
            type: "openai",
            name: "Mock OpenAI",
            baseUrl: mock.baseUrl,
            model: "gpt-4o-mini",
            timeoutSeconds: 30,
          },
          apiKey: "sk-test",
        })
        .expect(200);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe("RATE_LIMITED");
      expect(res.body.error.message).toContain("频率");
    } finally {
      mock.server.close();
    }
  });

  it("openai-compatible 连接测试必须提供 Base URL（缺省报错）", async () => {
    const res = await request(app)
      .post("/v1/providers/test")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        config: {
          id: "compat",
          type: "openai-compatible",
          name: "compat",
          model: "some-model",
          timeoutSeconds: 30,
        },
        apiKey: "key",
      })
      .expect(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("INVALID_REQUEST");
  });

  it("保存 Provider 后 API Key 进入 Vault，响应不含完整 Key", async () => {
    await request(app)
      .post("/v1/providers")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        config: {
          id: "openai-main",
          type: "openai",
          name: "我的 OpenAI",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          timeoutSeconds: 30,
        },
        apiKey: "sk-very-secret-123456",
      })
      .expect(201);

    const res = await request(app)
      .get("/v1/providers")
      .set("Authorization", `Bearer ${TOKEN}`)
      .expect(200);
    expect(res.body.providers).toHaveLength(1);
    expect(res.body.providers[0].model).toBe("gpt-4o-mini");
    expect(res.body.providers[0].apiKeyConfigured).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("sk-very-secret-123456");

    // Key 已入 Vault（可读取以验证，但绝不进入响应）。
    const withKey = await vault.getSecret(`providerKey:openai-main`);
    expect(withKey).toBe("sk-very-secret-123456");
  });

  it("PUT 更新未提供 apiKey 时保留原 Key", async () => {
    await request(app)
      .post("/v1/providers")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        config: { id: "p1", type: "openai", name: "A", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", timeoutSeconds: 30 },
        apiKey: "sk-original-key",
      })
      .expect(201);

    await request(app)
      .put("/v1/providers/p1")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ model: "gpt-4o" })
      .expect(200);

    const withKey = await vault.getSecret("providerKey:p1");
    expect(withKey).toBe("sk-original-key");
  });

  it("PUT 更新时提供新 apiKey 则覆盖 Vault 密钥", async () => {
    await request(app)
      .post("/v1/providers")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        config: { id: "p1", type: "openai", name: "A", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", timeoutSeconds: 30 },
        apiKey: "sk-old-key",
      })
      .expect(201);

    await request(app)
      .put("/v1/providers/p1")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ apiKey: "sk-new-key" })
      .expect(200);

    const withKey = await vault.getSecret("providerKey:p1");
    expect(withKey).toBe("sk-new-key");
  });

  it("DELETE 删除 Provider 时同步删除 Vault 密钥", async () => {
    await request(app)
      .post("/v1/providers")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        config: { id: "p1", type: "openai", name: "A", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", timeoutSeconds: 30 },
        apiKey: "sk-gone-key",
      })
      .expect(201);

    await request(app)
      .delete("/v1/providers/p1")
      .set("Authorization", `Bearer ${TOKEN}`)
      .expect(204);

    const withKey = await vault.getSecret("providerKey:p1");
    expect(withKey).toBeNull();
  });

  it("set-default 设置当前 Provider，删除后清除悬空引用", async () => {
    await request(app)
      .post("/v1/providers")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        config: { id: "p1", type: "openai", name: "A", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", timeoutSeconds: 30 },
      })
      .expect(201);

    await request(app)
      .post("/v1/providers/p1/set-default")
      .set("Authorization", `Bearer ${TOKEN}`)
      .expect(200);

    await request(app)
      .delete("/v1/providers/p1")
      .set("Authorization", `Bearer ${TOKEN}`)
      .expect(204);

    const res = await request(app)
      .get("/v1/providers")
      .set("Authorization", `Bearer ${TOKEN}`)
      .expect(200);
    expect(res.body.activeProviderId).toBe("");
  });

  it("GET /v1/analyze 已禁用（POST-only），返回 404", async () => {
    await request(app)
      .get("/v1/analyze")
      .set("Authorization", `Bearer ${TOKEN}`)
      .query({ text: "帮我写一个产品推广方案" })
      .expect(404);
  });

  it("POST /v1/analyze 未授权返回 401", async () => {
    await request(app)
      .post("/v1/analyze")
      .send({ originalText: "帮我写一个产品推广方案" })
      .expect(401);
  });

  it("POST /v1/analyze 合法请求返回结构化分析结果", async () => {
    const res = await request(app)
      .post("/v1/analyze")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        originalText: "帮我写一个产品推广方案",
        taskType: "auto",
        enhanceLevel: "deep",
        clarificationMode: "smart",
      })
      .expect(200);
    expect(res.body.detectedTaskType).toBe("business");
    expect(res.body.source).toBe("offline-heuristic");
    expect(typeof res.body.scoreDimensions.objective).toBe("number");
    expect(Array.isArray(res.body.missingInformation)).toBe(true);
    expect(Array.isArray(res.body.suggestions)).toBe(true);
  });

  it("POST /v1/analyze 空文本返回 400", async () => {
    await request(app)
      .post("/v1/analyze")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ originalText: "" })
      .expect(400);
  });

  it("POST /v1/analyze 纯空白/换行文本返回 400（修复 Q：不直达 LLM）", async () => {
    await request(app)
      .post("/v1/analyze")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ originalText: "   \n  \t " })
      .expect(400);
  });

  it("POST /v1/enhance 无默认 Provider 返回明确错误（不静默降级）", async () => {
    const res = await request(app)
      .post("/v1/enhance")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        originalText: "帮我写一个产品推广方案",
        taskType: "auto",
        enhanceLevel: "deep",
        clarificationMode: "smart",
      })
      .expect(200);
    // 无 Provider 时返回 passthrough 原文 + 明确错误码。
    expect(res.body.enhancedText).toBe("帮我写一个产品推广方案");
    expect(res.body.error?.code).toBe("INVALID_REQUEST");
    expect(res.body.error?.message).toContain("默认 Provider");
    // 不泄露任何敏感信息。
    expect(JSON.stringify(res.body)).not.toContain("sk-");
  });

  it("POST /v1/enhance 空文本返回 400", async () => {
    await request(app)
      .post("/v1/enhance")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ originalText: "" })
      .expect(400);
  });

  it("POST /v1/enhance 纯空白/换行文本返回 400（修复 Q：不直达 LLM 调用）", async () => {
    await request(app)
      .post("/v1/enhance")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ originalText: "\n\n   \n" })
      .expect(400);
  });

  it("未知接口返回 404 且不带敏感信息", async () => {
    const res = await request(app)
      .get("/v1/unknown")
      .set("Authorization", `Bearer ${TOKEN}`)
      .expect(404);
    expect(res.body.error.code).toBe("not_found");
  });

  it("POST /v1/providers/models 返回可用模型列表（不含 Key）", async () => {
    const mock = await startMockServer([
      { method: "GET", url: "/models", status: 200, body: { data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] } },
    ]);
    try {
      const res = await request(app)
        .post("/v1/providers/models")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({
          config: {
            id: "mock-openai",
            type: "openai",
            name: "Mock OpenAI",
            baseUrl: mock.baseUrl,
            model: "gpt-4o-mini",
            timeoutSeconds: 30,
          },
          apiKey: "sk-models-secret-123",
        })
        .expect(200);
      expect(res.body.providerType).toBe("openai");
      expect(res.body.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
      // 响应绝不包含 Key。
      expect(JSON.stringify(res.body)).not.toContain("sk-models-secret-123");
    } finally {
      mock.server.close();
    }
  });

  it("POST /v1/providers/models 无 apiKey 时从 Vault 读已保存 Key", async () => {
    const mock = await startMockServer([
      { method: "GET", url: "/models", status: 200, body: { data: [{ id: "claude-sonnet-5" }] } },
    ]);
    try {
      // 先保存 Provider（Key 入 Vault）。
      await request(app)
        .post("/v1/providers")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({
          config: {
            id: "saved-anthropic",
            type: "anthropic",
            name: "Saved",
            baseUrl: mock.baseUrl,
            model: "claude-sonnet-5",
            timeoutSeconds: 30,
          },
          apiKey: "sk-ant-vault-key-456",
        })
        .expect(201);
      // 不带 apiKey：路由从 Vault 读 Key 并成功拉取。
      const res = await request(app)
        .post("/v1/providers/models")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({
          config: {
            id: "saved-anthropic",
            type: "anthropic",
            name: "Saved",
            baseUrl: mock.baseUrl,
            model: "claude-sonnet-5",
            timeoutSeconds: 30,
          },
        })
        .expect(200);
      expect(res.body.models).toEqual(["claude-sonnet-5"]);
      expect(JSON.stringify(res.body)).not.toContain("sk-ant-vault-key-456");
    } finally {
      mock.server.close();
    }
  });

  it("POST /v1/providers/models 无 Key（未保存且未提供）→ api_key_missing", async () => {
    const res = await request(app)
      .post("/v1/providers/models")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        config: {
          id: "nokey",
          type: "openai",
          name: "NoKey",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          timeoutSeconds: 30,
        },
      })
      .expect(200);
    expect(res.body.error.code).toBe("api_key_missing");
    expect(res.body.models).toEqual([]);
  });

  it("POST /v1/providers/models 上游 401 → 统一安全错误（不泄露 Key/响应体）", async () => {
    const mock = await startMockServer([
      { method: "GET", url: "/models", status: 401, body: { error: { message: "Bad key sk-secret-xyz" } } },
    ]);
    try {
      const res = await request(app)
        .post("/v1/providers/models")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({
          config: {
            id: "badkey",
            type: "openai",
            name: "Bad",
            baseUrl: mock.baseUrl,
            model: "gpt-4o-mini",
            timeoutSeconds: 30,
          },
          apiKey: "sk-secret-xyz",
        })
        .expect(200);
      expect(res.body.error.code).toBe("INVALID_API_KEY");
      expect(JSON.stringify(res.body)).not.toContain("sk-secret-xyz");
      expect(JSON.stringify(res.body)).not.toContain("Bad key");
    } finally {
      mock.server.close();
    }
  });

  it("POST /v1/providers/models 请求体非法 → 400", async () => {
    await request(app)
      .post("/v1/providers/models")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ config: { id: "x", type: "openai" } }) // 缺 name/model/type 等
      .expect(400);
  });
});
