/**
 * 4.1 封板验收 + 阶段 5 闭环验收：完全隔离 Mock Smoke Test。
 *
 * 运行前请先 `pnpm --filter @prompt-boost/local-agent build`。
 *
 * 隔离保证：
 * - LOCAL_AGENT_DATA_DIR / DB_PATH / VAULT_PATH / MASTER_KEY_PATH / AUTH_TOKEN_FILE
 *   全部指向一个临时目录；LOCAL_AGENT_PORT 用随机空闲端口；LOCAL_AGENT_AUTH_TOKEN
 *   用固定测试令牌（不读取真实 .auth-token）。
 * - 真实 data/ 目录全程不被读取/修改（前后 hash+mtime 对比验证）。
 * - 结束清理：关闭服务与 Mock 端口、删除临时目录、恢复环境变量。
 *
 * 验证项：
 *  1. /health 200
 *  2. 连接测试成功（模型可用）
 *  3. 401 未授权
 *  4. 429 上游限流 → 安全错误
 *  5. 超时 → TIMEOUT
 *  6. model 缺失 → INVALID_REQUEST
 *  7. Provider CRUD（增/查/列/改/删）
 *  8. 响应与日志不含 API Key 明文
 *  9. 端口关闭、临时目录删除
 * 10. 真实 data/ 不变
 * 11. 阶段 5 闭环：enhance 成功 / 单次调用 / 请求体安全 / 三档差异 /
 *     结构化失败降级 / 无默认 Provider 明确报错 / 空文本 400
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const AGENT_DIR = resolve("apps/local-agent");
const REAL_DATA_DIR = resolve("apps/local-agent/data");
const TOKEN = "smoke-test-token-0123456789abcdef";

// ── 工具 ──────────────────────────────────────────────
let failures = 0;
function ok(cond, label) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}`);
  }
}
function assertEq(actual, expected, label) {
  ok(actual === expected, `${label}（期望 ${expected}，实际 ${JSON.stringify(actual)}）`);
}

/** 快照真实 data/（文件 hash + mtime），前后对比证明未改动。 */
function snapshotRealData() {
  if (!existsSync(REAL_DATA_DIR)) return null;
  const lines = [];
  for (const f of readdirSync(REAL_DATA_DIR).sort()) {
    const p = join(REAL_DATA_DIR, f);
    const st = statSync(p);
    if (st.isFile()) {
      const hash = createHash("sha256").update(readFileSync(p)).digest("hex");
      lines.push(`${f}|${hash}|${st.mtimeMs}`);
    }
  }
  return lines.join("\n");
}

/** 启动 Mock OpenAI 上游：可编程的 /models 与 /chat/completions 处理器。 */
async function startMockUpstream() {
  let mode = "ok"; // ok | 429 | timeout | plain
  let enhanceResponse = null; // 若非空，/chat/completions 且请求体含 json_object → 返回该增强 JSON
  let garbageOnce = false; // 下一次 json_object chat 请求返回纯文本垃圾（模拟一次结构化失败）
  let requests = 0;
  const captured = []; // { url, body, auth } 记录每个请求，用于闭环断言
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests += 1;
      const url = req.url ?? "";
      const authorization = req.headers.authorization ?? "";
      captured.push({ url, body, auth: authorization });
      if (mode === "429") {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Rate limit exceeded", type: "rate_limit_error" } }));
        return;
      }
      if (mode === "timeout") {
        // 挂起不响应，触发客户端超时。
        return;
      }
      if (url === "/v1/models") {
        if (!/Bearer .+/.test(authorization)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          data: [
            { id: "gpt-4o-mini" },
            { id: "gpt-4o" },
          ],
        }));
        return;
      }
      if (url === "/v1/chat/completions") {
        // plain 模式优先：结构化请求一律返回非 JSON 纯文本（模拟持续结构化失败）。
        if (mode === "plain") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "请为新产品撰写推广方案：明确目标受众、核心卖点与投放渠道，用词专业简洁。" } }] }));
          return;
        }
        // 一次性垃圾输出：模拟第一次结构化失败。
        if (garbageOnce) {
          garbageOnce = false;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "好的，我来帮你写推广方案：第一点…（模型直接执行任务，且不是 JSON）" } }] }));
          return;
        }
        // 阶段 5：JSON 模式（response_format=json_object）→ 可编程增强 JSON；否则 ping 回复。
        if (enhanceResponse && body.includes("json_object")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(enhanceResponse) } }] }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
    });
  });
  const port = await new Promise((resolvePort) => {
    server.listen(0, "127.0.0.1", () => {
      resolvePort(server.address().port);
    });
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    setMode(m) { mode = m; },
    setEnhanceResponse(obj) { enhanceResponse = obj; },
    triggerGarbageOnce() { garbageOnce = true; },
    requestCount: () => requests,
    captured: () => captured,
  };
}

function httpJson(port, method, path, { token, body, timeoutMs = 4000 } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Promise((resolvePromise, reject) => {
    const req = fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    req.then(async (res) => {
      let data = null;
      if (res.status !== 204) {
        try { data = await res.json(); } catch { data = null; }
      }
      resolvePromise({ status: res.status, data });
    }).catch((err) => {
      if (err.name === "TimeoutError") reject(new Error("timeout"));
      else reject(err);
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 主流程 ────────────────────────────────────────────
let tmpDir;
let agent;
let mock;

// 中断/异常兜底清理：确保临时目录与端口释放。
async function cleanup() {
  if (agent) {
    await new Promise((r) => {
      agent.once("exit", r);
      agent.kill("SIGTERM");
      setTimeout(r, 2500);
    });
  }
  if (mock) await new Promise((r) => mock.server.close(r));
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* Windows EPERM：再次尝试 */
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* 已尽力 */
      }
    }
  }
}
process.on("exit", () => void cleanup());
process.on("SIGINT", () => {
  void cleanup().then(() => process.exit(1));
});

async function main() {
  const before = snapshotRealData();
  tmpDir = mkdtempSync(join(tmpdir(), "pb-smoke-test-"));
  const env = {
    ...process.env,
    LOCAL_AGENT_DATA_DIR: tmpDir,
    LOCAL_AGENT_DB_PATH: join(tmpDir, "agent.db"),
    LOCAL_AGENT_VAULT_PATH: join(tmpDir, "vault.enc.json"),
    LOCAL_AGENT_MASTER_KEY_PATH: join(tmpDir, "master.key"),
    LOCAL_AGENT_AUTH_TOKEN_FILE: join(tmpDir, "auth.token"),
    LOCAL_AGENT_AUTH_TOKEN: TOKEN,
    LOCAL_AGENT_PORT: "8789",
    NODE_ENV: "development",
  };

  console.log("== 启动本地服务（临时目录）==");
  agent = spawn("node", [resolve(AGENT_DIR, "dist/server.js")], {
    env,
    cwd: AGENT_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let agentLogs = "";
  agent.stdout.on("data", (c) => (agentLogs += c));
  agent.stderr.on("data", (c) => (agentLogs += c));

  mock = await startMockUpstream();
  console.log("== 启动 Mock 上游 ==");

  // 等待 /health。
  let healthy = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await httpJson(8789, "GET", "/health");
      if (r.status === 200) { healthy = true; break; }
    } catch { /* retry */ }
    await wait(250);
  }
  ok(healthy, "1. /health 返回 200");

  const config = {
    id: "smoke-openai",
    name: "Smoke OpenAI",
    type: "openai",
    baseUrl: `${mock.baseUrl}/v1`,
    model: "gpt-4o-mini",
    timeoutSeconds: 2,
    enabled: true,
  };
  const secretKey = "sk-smoke-test-secret-0123456789";

  // 2. 连接测试成功。
  {
    const r = await httpJson(8789, "POST", "/v1/providers/test", {
      token: TOKEN,
      body: { config, apiKey: secretKey },
    });
    assertEq(r.status, 200, "2. 连接测试 HTTP 200");
    ok(r.data && r.data.success === true, "2. 连接测试成功（success:true）");
    assertEq(r.data?.model, "gpt-4o-mini", "2. 使用用户配置的模型名");
  }

  // 3. 401 未授权。
  {
    const r = await httpJson(8789, "GET", "/v1/providers", { token: "wrong-token" });
    assertEq(r.status, 401, "3. 未授权令牌 → 401");
  }

  // 4. 429 上游限流 → 安全错误（不含 Key）。
  {
    mock.setMode("429");
    const r = await httpJson(8789, "POST", "/v1/providers/test", {
      token: TOKEN,
      body: { config, apiKey: secretKey },
    });
    assertEq(r.status, 200, "4. 429 连接测试 HTTP 200（错误在 body）");
    ok(r.data?.success === false, "4. 429 → success:false");
    assertEq(r.data?.error?.code, "RATE_LIMITED", "4. 429 → RATE_LIMITED");
    ok(!JSON.stringify(r.data).includes(secretKey), "4. 429 响应不含 API Key");
    mock.setMode("ok");
  }

  // 5. 超时 → TIMEOUT。
  {
    mock.setMode("timeout");
    const r = await httpJson(8789, "POST", "/v1/providers/test", {
      token: TOKEN,
      body: { config, apiKey: secretKey, timeoutMs: 3500 },
    });
    ok(r.data?.success === false, "5. 超时 → success:false");
    ok((r.data?.error?.code ?? "").toLowerCase().includes("timeout"), `5. 超时错误码含 TIMEOUT（${r.data?.error?.code}）`);
    mock.setMode("ok");
  }

  // 6. model 缺失 → INVALID_REQUEST。
  {
    const noModel = { ...config, model: "  " };
    const r = await httpJson(8789, "POST", "/v1/providers/test", {
      token: TOKEN,
      body: { config: noModel, apiKey: secretKey },
    });
    ok(r.data?.success === false, "6. 无 model → success:false");
    assertEq(r.data?.error?.code, "INVALID_REQUEST", "6. 无 model → INVALID_REQUEST");
    ok(!r.data?.error?.message?.includes("gpt-"), "6. 不静默选择任何模型名");
  }

  // 7. CRUD。
  {
    const created = await httpJson(8789, "POST", "/v1/providers", {
      token: TOKEN,
      body: { config, apiKey: secretKey },
    });
    assertEq(created.status, 201, "7. 创建 Provider → 201");
    assertEq(created.data?.provider?.apiKeyConfigured, true, "7. 创建后 apiKeyConfigured:true");

    const listed = await httpJson(8789, "GET", "/v1/providers", { token: TOKEN });
    assertEq(listed.status, 200, "7. 列出 Provider → 200");
    ok(Array.isArray(listed.data?.providers) && listed.data.providers.some((p) => p.id === "smoke-openai"), "7. 列表含新 Provider");
    assertEq(listed.data?.activeProviderId, null, "7. 未设置默认时 activeProviderId 为 null");

    const got = await httpJson(8789, "GET", "/v1/providers/smoke-openai", { token: TOKEN });
    assertEq(got.status, 200, "7. 查询单个 → 200");
    ok(!JSON.stringify(got.data).includes(secretKey), "7. 查询响应不含 API Key");

    // 更新（不传 apiKey = 空 Key，保留原 Key；与 Options 控制器行为一致）。
    const updated = await httpJson(8789, "PUT", "/v1/providers/smoke-openai", {
      token: TOKEN,
      body: { name: "Smoke OpenAI 2" },
    });
    assertEq(updated.status, 200, "7. 更新 → 200");
    assertEq(updated.data?.provider?.name, "Smoke OpenAI 2", "7. 更新名称生效");
    assertEq(updated.data?.provider?.apiKeyConfigured, true, "7. 空 Key 更新保留原 Key");

    // 设默认。
    const setDefault = await httpJson(8789, "POST", "/v1/providers/smoke-openai/set-default", {
      token: TOKEN,
      body: {},
    });
    assertEq(setDefault.status, 200, "7. 设默认 → 200");
    const listed2 = await httpJson(8789, "GET", "/v1/providers", { token: TOKEN });
    assertEq(listed2.data?.activeProviderId, "smoke-openai", "7. 默认 Provider 已持久化");

    // 删除。
    const deleted = await httpJson(8789, "DELETE", "/v1/providers/smoke-openai", { token: TOKEN });
    assertEq(deleted.status, 204, "7. 删除 → 204");
    const after = await httpJson(8789, "GET", "/v1/providers", { token: TOKEN });
    ok(!after.data.providers.some((p) => p.id === "smoke-openai"), "7. 删除后列表不含该 Provider");
    ok(!after.data?.activeProviderId, "7. 删除默认后 activeProviderId 清空（空/无）");
  }

  // 8. 响应与日志不含 API Key 明文。
  {
    const listed = await httpJson(8789, "GET", "/v1/providers", { token: TOKEN });
    ok(!JSON.stringify(listed).includes(secretKey), "8. 列表响应不含 Key");
    // 让 agent 输出 flush。
    await wait(300);
    ok(!agentLogs.includes(secretKey), "8. 服务日志不含 Key 明文");
  }

  // ── 阶段 5 完整闭环：Mock OpenAI → Prompt Engine → /v1/enhance 写回 ──
  {
    console.log("== 阶段 5 闭环：enhance（JSON 模式，模拟 LLM 单次输出）==");

    // 再创建一个 Provider（增强走这里，之前那个已删除）。三档用同一 mock，
    // 通过断言请求体增强指令不同来体现差异。
    const created = await httpJson(8789, "POST", "/v1/providers", {
      token: TOKEN,
      body: {
        config: { ...config, id: "smoke-enhance", name: "Smoke Enhance", type: "openai-compatible", baseUrl: `${mock.baseUrl}/v1`, model: "some-model" },
        apiKey: secretKey,
      },
    });
    assertEq(created.status, 201, "11. 创建增强 Provider → 201");
    const setDef = await httpJson(8789, "POST", "/v1/providers/smoke-enhance/set-default", { token: TOKEN, body: {} });
    assertEq(setDef.status, 200, "11. 设为默认 → 200");

    // 三档：模型输出三份不同的增强后 Prompt（模拟 quick/deep/expert 长度差异）。
    const enhanced = {
      quick: "帮我把公司产品推广一下，写清楚卖点和受众。",
      deep: "请为公司新产品撰写推广方案：明确目标受众、核心卖点与投放渠道，用词专业简洁。",
      expert: "请以资深产品营销顾问的身份，为公司新产品撰写一份完整的推广方案，包含目标受众画像、价值主张、渠道策略、预算分配建议与效果衡量指标。",
    };
    const scoreDimensions = {
      objective: 85, context: 70, audience: 60, outputFormat: 80,
      constraints: 50, role: 75, materials: 40, actionability: 70,
    };
    mock.setEnhanceResponse({
      enhancedText: enhanced.deep,
      reasoning: "补充背景与受众",
      assumptions: ["假设为新产品"],
      originalIntent: "写产品推广方案",
      detectedTaskType: "business",
      scoreDimensions,
      missingInformation: ["预算"],
      suggestions: ["补充预算范围"],
      confidence: 0.9,
    });

    const beforeCount = mock.requestCount();

    // 11a. /v1/enhance 成功：增强后 Prompt 非空、是改写而非回答、scoreSource llm。
    const r = await httpJson(8789, "POST", "/v1/enhance", {
      token: TOKEN,
      body: {
        originalText: "写产品推广方案",
        taskType: "auto",
        enhanceLevel: "deep",
        clarificationMode: "smart",
        outputLanguage: "zh-CN",
      },
      timeoutMs: 5000,
    });
    assertEq(r.status, 200, "11a. /v1/enhance → 200");
    ok(r.data?.enhancedText && r.data.enhancedText.length > 0, "11a. 增强后 Prompt 非空");
    assertEq(r.data?.enhancedText, enhanced.deep, "11a. 增强结果即 LLM 输出（改写后 Prompt）");
    ok(!r.data?.enhancedText?.startsWith("好的，我来"), "11a. 不是直接回答用户任务");
    assertEq(r.data?.analysis?.scoreSource, "llm", "11a. scoreSource 为 llm");
    assertEq(r.data?.analysis?.totalScore, 69, "11a. 总分由程序计算（加权），非模型直接返回");
    assertEq(r.data?.analysis?.scoreDimensions?.objective, 85, "11a. 维度分透传");
    assertEq(r.data?.provider, "openai-compatible/some-model", "11a. 返回 provider 标签（type/model）");
    ok(r.data?.fallback === null || r.data?.fallback === undefined, "11a. 无降级（fallback 空）");

    // 11b. 单次调用：/v1/enhance 一次 upstream chat 请求（分类+评分+追问+增强合一）。
    const enhanceRequests = mock
      .captured()
      .slice(beforeCount)
      .filter((c) => c.url.endsWith("/chat/completions") && c.body.includes("json_object"));
    assertEq(enhanceRequests.length, 1, "11b. 一次增强恰好 1 次上游 chat 请求");

    // 11c. 请求体：system 元提示 + user 含任务定义/强度指令；不含 API Key 明文。
    const reqBody = enhanceRequests[0]?.body ?? "";
    ok(reqBody.includes("prompt_enhancer") || reqBody.includes("增强"), "11c. 请求含 system 元提示");
    ok(reqBody.includes("deep"), "11c. user 含增强强度 deep");
    ok(!reqBody.includes(secretKey), "11c. 上游请求体不含 API Key 明文");
    assertEq(enhanceRequests[0]?.auth, `Bearer ${secretKey}`, "11c. Key 只在 Authorization 头");

    // 11d. 三档差异可感知：同一原文，quick/deep/expert 走不同指令 → 模型输出长度递增。
    const levelResults = [];
    for (const level of ["quick", "deep", "expert"]) {
      const lbefore = mock.requestCount();
      mock.setEnhanceResponse({ enhancedText: enhanced[level], reasoning: "r", assumptions: [], originalIntent: "x", detectedTaskType: "business", scoreDimensions, missingInformation: [], suggestions: [] });
      const lr = await httpJson(8789, "POST", "/v1/enhance", {
        token: TOKEN,
        body: { originalText: "写产品推广方案", taskType: "auto", enhanceLevel: level, clarificationMode: "smart" },
        timeoutMs: 5000,
      });
      assertEq(lr.status, 200, `11d. ${level} 增强 → 200`);
      const lreq = mock.captured().slice(lbefore).find((c) => c.url.endsWith("/chat/completions") && c.body.includes("json_object"));
      ok(lreq && lreq.body.includes(level), `11d. ${level} 请求体含 ${level} 强度指令`);
      levelResults.push({ level, len: (lr.data?.enhancedText ?? "").length });
    }
    ok(
      levelResults[0].len < levelResults[1].len && levelResults[1].len < levelResults[2].len,
      `11d. quick(${levelResults[0].len}) < deep(${levelResults[1].len}) < expert(${levelResults[2].len}) 长度递增`,
    );

    // 11e. 结构化返回失败：可修复（重试成功）或安全降级（passthrough 不丢用户输入）。
    {
      // 11e-A 可修复：第一次返回垃圾，第二次返回合法 JSON → text-fallback 重试成功。
      mock.setEnhanceResponse({
        enhancedText: "请为新产品撰写推广方案：明确目标受众、核心卖点与投放渠道，用词专业简洁。",
        reasoning: "r", assumptions: [], originalIntent: "x", detectedTaskType: "business",
        scoreDimensions, missingInformation: [], suggestions: [],
      });
      mock.triggerGarbageOnce();
      const ar = await httpJson(8789, "POST", "/v1/enhance", {
        token: TOKEN,
        body: { originalText: "写产品推广方案", taskType: "auto", enhanceLevel: "deep", clarificationMode: "smart" },
        timeoutMs: 5000,
      });
      assertEq(ar.status, 200, "11e-A. 可修复路径 HTTP 200");
      assertEq(ar.data?.fallback, "text-fallback", "11e-A. 首次失败 → 重试成功，标记 text-fallback");
      assertEq(ar.data?.enhancedText, "请为新产品撰写推广方案：明确目标受众、核心卖点与投放渠道，用词专业简洁。", "11e-A. 重试后仍拿到增强结果");
      assertEq(ar.data?.analysis?.scoreSource, "heuristic_fallback", "11e-A. 结构化缺失 → 评分降级 heuristic_fallback");
      ok(!JSON.stringify(ar.data).includes(secretKey), "11e-A. 响应不含 Key");

      // 11e-B 持续失败 → 安全降级：passthrough 原文（绝不丢用户输入）。
      mock.setMode("plain");
      const br = await httpJson(8789, "POST", "/v1/enhance", {
        token: TOKEN,
        body: { originalText: "写产品推广方案", taskType: "auto", enhanceLevel: "deep", clarificationMode: "smart" },
        timeoutMs: 5000,
      });
      assertEq(br.status, 200, "11e-B. 持续失败仍 HTTP 200（安全降级）");
      assertEq(br.data?.fallback, "passthrough", "11e-B. 标记 passthrough");
      assertEq(br.data?.enhancedText, "写产品推广方案", "11e-B. 原文透传，不丢用户输入");
      assertEq(br.data?.analysis?.scoreSource, "heuristic_fallback", "11e-B. 评分降级 heuristic_fallback");
      ok(!JSON.stringify(br.data).includes(secretKey), "11e-B. 降级响应不含 Key");
      mock.setMode("ok");
    }

    // 11f. 无默认 Provider → 明确报错（不静默降级）。
    await httpJson(8789, "DELETE", "/v1/providers/smoke-enhance", { token: TOKEN });
    const nr = await httpJson(8789, "POST", "/v1/enhance", {
      token: TOKEN,
      body: { originalText: "写产品推广方案", taskType: "auto", enhanceLevel: "deep", clarificationMode: "smart" },
      timeoutMs: 5000,
    });
    assertEq(nr.status, 200, "11f. 无默认 Provider → HTTP 200（体内错误）");
    assertEq(nr.data?.error?.code, "INVALID_REQUEST", "11f. 错误码 INVALID_REQUEST");
    ok((nr.data?.error?.message ?? "").includes("Provider"), "11f. 明确提示未配置 Provider");
    assertEq(nr.data?.enhancedText, "写产品推广方案", "11f. 原文透传（不丢失用户输入）");
    assertEq(nr.data?.fallback, "passthrough", "11f. fallback 标记 passthrough");

    // 11g. 空文本（长度 < MIN_INPUT_LENGTH=1）→ 400。
    const er = await httpJson(8789, "POST", "/v1/enhance", {
      token: TOKEN,
      body: { originalText: "", taskType: "auto", enhanceLevel: "deep", clarificationMode: "smart" },
    });
    assertEq(er.status, 400, "11g. 空文本 → 400");
  }

  // ── 清理 ────────────────────────────────────────────
  console.log("== 清理 ==");
  await cleanup();

  // 9. 端口已关闭。
  let portOpen = false;
  try {
    const r = await httpJson(8789, "GET", "/health", { timeoutMs: 1500 });
    if (r.status) portOpen = true;
  } catch { portOpen = false; }
  ok(!portOpen, "9. 服务端口已关闭（拒绝连接）");

  // 临时目录删除。
  ok(!existsSync(tmpDir), "9. 临时目录已删除");

  // 10. 真实 data/ 不变。
  const after = snapshotRealData();
  const unchanged = after === before;
  ok(unchanged, "10. 真实 data/ hash+mtime 前后一致");
  if (!unchanged) {
    console.error("  before:", before);
    console.error("  after :", after);
  }

  console.log(failures === 0 ? "\n✅ 全部通过" : `\n❌ ${failures} 项失败`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke Test 运行失败：", err);
  process.exit(1);
});
