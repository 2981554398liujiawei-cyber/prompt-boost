// 客户端断连中止：/v1/enhance 在客户端断开时中止上游 LLM 调用（避免孤儿请求）。
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

const TOKEN = "test-token-disconnect-abcdef";

afterAll(() => {
  delete process.env.LOCAL_AGENT_DATA_DIR;
});

/** 慢上游：收到请求后挂起不响应；记录是否被 abort（socket 被销毁）。 */
function startSlowUpstream(): Promise<{ server: Server; baseUrl: string; aborted: () => boolean; requests: () => number }> {
  let upstreamAborted = false;
  let upstreamRequests = 0;
  const server = createServer((_req, res) => {
    upstreamRequests += 1;
    res.on("close", () => {
      // 正常完成（writableEnded=true）与断连（false）都会触发 close，
      // 需用 writableEnded 区分：慢上游从不 end，故 close 即断连。
      if (!res.writableEnded) upstreamAborted = true;
    });
    // 不 res.end()：请求一直挂着。
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        resolve({
          server,
          baseUrl: `http://127.0.0.1:${address.port}`,
          aborted: () => upstreamAborted,
          requests: () => upstreamRequests,
        });
      }
    });
  });
}

/** 正常上游：立即返回有效单块 JSON；记录是否被断连中止。 */
function startOkUpstream(): Promise<{ server: Server; baseUrl: string; aborted: () => boolean; requests: () => number }> {
  let upstreamAborted = false;
  let upstreamRequests = 0;
  const okBody = JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            enhancedText: "请为新产品撰写推广方案：明确目标受众、核心卖点与投放渠道。",
            reasoning: "",
            assumptions: [],
            originalIntent: "写推广方案",
            detectedTaskType: "marketing",
            scoreDimensions: { clarity: 8, completeness: 6 },
            missingInformation: [],
            criticalMissingInformation: [],
            suggestions: [],
          }),
        },
      },
    ],
  });
  const server = createServer((_req, res) => {
    upstreamRequests += 1;
    res.on("close", () => {
      // 正常 end 后 close 时 writableEnded=true，不算断连中止。
      if (!res.writableEnded) upstreamAborted = true;
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(okBody);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "object" && address) {
        resolve({
          server,
          baseUrl: `http://127.0.0.1:${address.port}`,
          aborted: () => upstreamAborted,
          requests: () => upstreamRequests,
        });
      }
    });
  });
}

/** 等待条件成立（带超时）。 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

describe("local-agent app：客户端断连中止上游调用", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof createApp>;
  let upstream: Awaited<ReturnType<typeof startSlowUpstream>>;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-disc-"));
    db = openDatabase(join(dir, "test.db"));
    const vault = await createVault();
    app = createApp({
      db,
      vault,
      authToken: TOKEN,
      version: "0.1.0-test",
      promptEngine: createPromptEngine(db, vault),
    });
    upstream = await startSlowUpstream();
    // 配置默认 Provider（supertest 走内存 transport，不需真实 socket）。
    await request(app)
      .post("/v1/providers")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        config: { id: "slow", type: "openai", name: "慢 Provider", baseUrl: upstream.baseUrl, model: "gpt-4o-mini", timeoutSeconds: 60 },
        apiKey: "sk-test-disconnect-key",
      })
      .expect(201);
    await request(app)
      .post("/v1/providers/slow/set-default")
      .set("Authorization", `Bearer ${TOKEN}`)
      .expect(200);
  });

  afterEach(() => {
    db.close();
    upstream.server.close();
  });

  it("客户端断连后，上游 LLM 调用被中止（孤儿请求清理）", async () => {
    // 真实 HTTP 服务器上发 /v1/enhance，客户端中途 abort。
    await new Promise<void>((resolve, reject) => {
      const httpServer = app.listen(0, "127.0.0.1", () => {
        const address = httpServer.address();
        if (typeof address !== "object" || !address) {
          reject(new Error("no address"));
          return;
        }
        const controller = new AbortController();
        fetch(`http://127.0.0.1:${address.port}/v1/enhance`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify({
            originalText: "帮我写一个产品推广方案",
            taskType: "auto",
            enhanceLevel: "deep",
            clarificationMode: "smart",
          }),
          signal: controller.signal,
        }).catch(() => null);
        // 等上游真正收到请求后断开客户端连接。
        setTimeout(() => controller.abort(), 300);
        setTimeout(() => httpServer.close(() => resolve()), 800);
      });
    });

    // 断言上游调用被中止（socket 销毁 → res close）。
    expect(upstream.requests()).toBeGreaterThanOrEqual(1);
    const aborted = await waitFor(() => upstream.aborted());
    expect(aborted).toBe(true);
  });

  it("正常完成时上游调用不被中止（对照）", async () => {
    // 换成正常快速响应的上游，走完整成功路径：请求正常返回，且上游不被标记为断连中止。
    const ok = await startOkUpstream();
    try {
      await request(app)
        .put("/v1/providers/slow")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ baseUrl: ok.baseUrl })
        .expect(200);

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
      // 正常完成：enhancedText 为上游返回的增强结果，非 passthrough。
      expect(res.body.enhancedText).toBe("请为新产品撰写推广方案：明确目标受众、核心卖点与投放渠道。");
      expect(res.body.error).toBeUndefined();
      // 上游成功响应后正常 close（非断连），请求未被中止。
      expect(ok.aborted()).toBe(false);
    } finally {
      ok.server.close();
    }
  });
});
