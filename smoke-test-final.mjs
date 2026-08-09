/**
 * Prompt Boost MVP 最终验收 Smoke Test（Stage 8）。
 *
 * 完全隔离：临时目录承载全部数据（LOCAL_AGENT_DATA_DIR / DB_PATH / VAULT_PATH /
 * MASTER_KEY_PATH / AUTH_TOKEN_FILE）；LOCAL_AGENT_PORT 用随机空闲端口；
 * LOCAL_AGENT_AUTH_TOKEN 用固定测试令牌；真实 data/ 全程不被读取/修改
 * （前后 hash+mtime 对比验证）。
 *
 * 运行前请先 `pnpm --filter @prompt-boost/local-agent build`（或 pnpm build）。
 *
 * 验证项：
 *  1. /health 200
 *  2. 401 未授权
 *  3. 连接测试成功（模型可用、Bearer 头）
 *  4. Provider CRUD + 默认持久化
 *  5. Key 明文绝不出现于响应 / 日志 / 上游请求体
 *  6. MVP 闭环 /v1/enhance：
 *     a. 正常增强 1 次调用，scoreSource=llm，总分由程序计算
 *     b. 追问闭环：首轮产问题（clarificationRequired+questions≤3）→ 带 answers 二轮最终结果
 *        （累计 2 次调用；questions 只出现在首轮）
 *     c. clarificationMode=off：即使模型产问题也强制为空（1 次调用）
 *     d. 结构化失败 → text-fallback（可修复）或 passthrough（不丢用户输入）
 *     e. 无默认 Provider → 明确 INVALID_REQUEST + 原文透传
 *     f. 空文本 → 400
 *  7. /v1/analyze 离线启发式（scoreSource=heuristic_fallback，不调用模型）
 *  8. 清理：端口关闭、临时目录删除、真实 data/ 前后一致
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const AGENT_DIR = resolve("apps/local-agent");
const REAL_DATA_DIR = resolve("apps/local-agent/data");
const TOKEN = "pb-final-smoke-token-0123456789abcdef";

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
  ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
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

/**
 * 启动 Mock 上游：可编程 /v1/models 与 /v1/chat/completions。
 * enhanceSequence：按次序对「json_object 增强请求」出响应；超出取最后一个。
 */
async function startMockUpstream() {
  let mode = "ok"; // ok | 429 | timeout | plain
  let enhanceSequence = [];
  let seqIdx = 0;
  let garbageOnce = false;
  let requests = 0;
  const captured = []; // { url, body, auth }
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
      if (mode === "timeout") return; // 挂起，触发客户端超时。
      if (url === "/v1/models") {
        if (!/Bearer .+/.test(authorization)) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o-mini" }, { id: "gpt-4o" }] }));
        return;
      }
      if (url === "/v1/chat/completions") {
        if (mode === "plain") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "请为新产品撰写推广方案：明确目标受众、核心卖点与投放渠道。" } }] }));
          return;
        }
        if (garbageOnce) {
          garbageOnce = false;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: "好的，我来帮你写推广方案：第一点…（非 JSON）" } }] }));
          return;
        }
        if (body.includes("json_object") && enhanceSequence.length > 0) {
          const idx = Math.min(seqIdx, enhanceSequence.length - 1);
          seqIdx += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(enhanceSequence[idx]) } }] }));
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
    server.listen(0, "127.0.0.1", () => resolvePort(server.address().port));
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    setMode(m) { mode = m; },
    setEnhanceSequence(arr) { enhanceSequence = arr; seqIdx = 0; },
    triggerGarbageOnce() { garbageOnce = true; },
    requestCount: () => requests,
    captured: () => captured,
  };
}

function httpJson(port, method, path, { token, body, timeoutMs = 4000 } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }).then(async (res) => {
    let data = null;
    if (res.status !== 204) {
      try { data = await res.json(); } catch { data = null; }
    }
    return { status: res.status, data };
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 获取一个当前空闲的 TCP 端口（LOCAL_AGENT_PORT 用随机端口，避免与真实服务冲突）。 */
function getRandomFreePort() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

// ── 主流程 ────────────────────────────────────────────
let tmpDir;
let agent;
let mock;

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
    for (let i = 0; i < 2; i++) {
      try { rmSync(tmpDir, { recursive: true, force: true }); break; }
      catch { /* Windows EPERM：重试 */ }
    }
  }
}
process.on("exit", () => void cleanup());
process.on("SIGINT", () => { void cleanup().then(() => process.exit(1)); });

async function main() {
  const before = snapshotRealData();
  tmpDir = mkdtempSync(join(tmpdir(), "pb-final-smoke-"));
  // 随机空闲端口：与真实服务（默认 8787/8789）完全隔离，避免 EADDRINUSE。
  const PORT = await getRandomFreePort();
  const env = {
    ...process.env,
    LOCAL_AGENT_DATA_DIR: tmpDir,
    LOCAL_AGENT_DB_PATH: join(tmpDir, "agent.db"),
    LOCAL_AGENT_VAULT_PATH: join(tmpDir, "vault.enc.json"),
    LOCAL_AGENT_MASTER_KEY_PATH: join(tmpDir, "master.key"),
    LOCAL_AGENT_AUTH_TOKEN_FILE: join(tmpDir, "auth.token"),
    LOCAL_AGENT_AUTH_TOKEN: TOKEN,
    LOCAL_AGENT_PORT: String(PORT),
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

  // 1. 等待 /health。
  let healthy = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await httpJson(PORT, "GET", "/health");
      if (r.status === 200) { healthy = true; break; }
    } catch { /* retry */ }
    await wait(250);
  }
  ok(healthy, "1. /health 返回 200");

  // 2. 401 未授权。
  {
    const r = await httpJson(PORT, "GET", "/v1/providers", { token: "wrong-token" });
    assertEq(r.status, 401, "2. 未授权令牌 → 401");
  }

  const config = {
    id: "final-openai",
    name: "Final OpenAI",
    type: "openai",
    baseUrl: `${mock.baseUrl}/v1`,
    model: "gpt-4o-mini",
    timeoutSeconds: 5,
    enabled: true,
  };
  const secretKey = "sk-final-smoke-secret-0123456789";

  // 3. 连接测试成功（使用用户配置的 model）。
  {
    const r = await httpJson(PORT, "POST", "/v1/providers/test", {
      token: TOKEN,
      body: { config, apiKey: secretKey },
    });
    assertEq(r.status, 200, "3. 连接测试 HTTP 200");
    ok(r.data?.success === true, "3. 连接测试成功（success:true）");
    assertEq(r.data?.model, "gpt-4o-mini", "3. 使用用户配置的模型名");
    ok(!JSON.stringify(r.data).includes(secretKey), "3. 连接测试响应不含 API Key");
  }

  // 3.5 拉取可用模型列表（Options 页「获取可用模型」）。
  {
    const r = await httpJson(PORT, "POST", "/v1/providers/models", {
      token: TOKEN,
      body: { config, apiKey: secretKey },
    });
    assertEq(r.status, 200, "3.5. 模型列表 HTTP 200");
    assertEq(r.data?.providerType, "openai", "3.5. 返回 providerType");
    ok(Array.isArray(r.data?.models) && r.data.models.includes("gpt-4o"), "3.5. 返回可用模型列表");
    ok(!JSON.stringify(r.data).includes(secretKey), "3.5. 模型列表响应不含 API Key");
  }

  // 4. Provider CRUD + 默认。
  {
    const created = await httpJson(PORT, "POST", "/v1/providers", {
      token: TOKEN,
      body: { config, apiKey: secretKey },
    });
    assertEq(created.status, 201, "4. 创建 Provider → 201");
    const setDef = await httpJson(PORT, "POST", "/v1/providers/final-openai/set-default", { token: TOKEN, body: {} });
    assertEq(setDef.status, 200, "4. 设默认 → 200");
    const listed = await httpJson(PORT, "GET", "/v1/providers", { token: TOKEN });
    assertEq(listed.data?.activeProviderId, "final-openai", "4. 默认 Provider 已持久化");
    assertEq(listed.data?.providers?.[0]?.apiKeyConfigured, true, "4. apiKeyConfigured=true（不回显 Key）");
    const got = await httpJson(PORT, "GET", "/v1/providers/final-openai", { token: TOKEN });
    ok(!JSON.stringify(got.data).includes(secretKey), "4. 查询响应不含 Key 明文");
  }

  // 5. 响应与日志不含 API Key 明文。
  {
    const listed = await httpJson(PORT, "GET", "/v1/providers", { token: TOKEN });
    ok(!JSON.stringify(listed).includes(secretKey), "5. 列表响应不含 Key");
    await wait(300);
    ok(!agentLogs.includes(secretKey), "5. 服务日志不含 Key 明文");
  }

  // ── 6. MVP 闭环 /v1/enhance ─────────────────────────
  {
    console.log("== 6. 闭环：enhance（单次 LLM 调用）==");

    const scoreDimensions = {
      objective: 85, context: 70, audience: 60, outputFormat: 80,
      constraints: 50, role: 75, materials: 40, actionability: 70,
    };
    const finalEnhance = {
      enhancedText: "请为公司新产品撰写推广方案：明确目标受众、核心卖点与投放渠道，用词专业简洁。",
      reasoning: "补充背景与受众",
      assumptions: ["假设为新产品"],
      originalIntent: "写产品推广方案",
      detectedTaskType: "business",
      scoreDimensions,
      missingInformation: ["预算"],
      criticalMissingInformation: [],
      suggestions: ["补充预算范围"],
      confidence: 0.9,
      clarificationRequired: false,
      clarificationQuestions: [],
    };
    const askEnhance = {
      ...finalEnhance,
      enhancedText: "请为公司新产品撰写推广方案（待确认市场与预算）。",
      clarificationRequired: true,
      criticalMissingInformation: ["目标市场", "预算"],
      clarificationQuestions: [
        { id: "q1", question: "推广的目标市场是？", reason: "影响策略选择", required: true },
        { id: "q2", question: "预算范围？", reason: "影响方案深度", required: false },
        { id: "q3", question: "期望的推广周期？", reason: "影响排期", required: false },
      ],
    };

    // 6a. 正常增强：1 次调用、scoreSource=llm、总分程序计算。
    {
      mock.setEnhanceSequence([finalEnhance]);
      const beforeCount = mock.requestCount();
      const r = await httpJson(PORT, "POST", "/v1/enhance", {
        token: TOKEN,
        body: { originalText: "写产品推广方案", taskType: "auto", enhanceLevel: "deep", clarificationMode: "smart" },
        timeoutMs: 5000,
      });
      assertEq(r.status, 200, "6a. /v1/enhance → 200");
      ok(r.data?.enhancedText?.length > 0, "6a. 增强后 Prompt 非空");
      ok(!r.data?.enhancedText?.startsWith("好的，我来"), "6a. 不是直接回答用户任务");
      assertEq(r.data?.analysis?.scoreSource, "llm", "6a. scoreSource=llm");
      assertEq(r.data?.analysis?.totalScore, 69, "6a. 总分由程序计算（加权），非模型直接返回");
      assertEq(r.data?.analysis?.clarificationRequired, false, "6a. 无追问（clarificationRequired=false）");
      assertEq(r.data?.provider, "openai/gpt-4o-mini", "6a. 返回 provider 标签（type/model）");
      const upstream = mock.captured().slice(beforeCount).filter((c) => c.url.endsWith("/chat/completions") && c.body.includes("json_object"));
      assertEq(upstream.length, 1, "6a. 一次增强恰好 1 次上游 chat 请求");
      ok(!upstream[0]?.body.includes(secretKey), "6a. 上游请求体不含 API Key 明文");
      assertEq(upstream[0]?.auth, `Bearer ${secretKey}`, "6a. Key 只在 Authorization 头");
    }

    // 6b. 追问闭环：首轮产问题 → 带 answers 二轮最终结果（累计 2 次）。
    {
      mock.setEnhanceSequence([askEnhance, finalEnhance]);
      const beforeCount = mock.requestCount();
      const r1 = await httpJson(PORT, "POST", "/v1/enhance", {
        token: TOKEN,
        body: { originalText: "写产品推广方案", taskType: "auto", enhanceLevel: "deep", clarificationMode: "smart" },
        timeoutMs: 5000,
      });
      assertEq(r1.status, 200, "6b. 首轮 → 200");
      assertEq(r1.data?.analysis?.clarificationRequired, true, "6b. 首轮返回 clarificationRequired=true");
      assertEq(r1.data?.analysis?.criticalMissingInformation?.length, 2, "6b. 关键缺失信息透传（2 项）");
      assertEq(r1.data?.analysis?.clarificationQuestions?.length, 3, "6b. 首轮返回 3 个问题（≤3）");
      assertEq(r1.data?.analysis?.clarificationQuestions?.[0]?.question, "推广的目标市场是？", "6b. 问题透传");

      const r2 = await httpJson(PORT, "POST", "/v1/enhance", {
        token: TOKEN,
        body: {
          originalText: "写产品推广方案",
          taskType: "auto",
          enhanceLevel: "deep",
          clarificationMode: "smart",
          clarificationAnswers: { q1: "面向中小企业", q2: "预算 10 万" },
        },
        timeoutMs: 5000,
      });
      assertEq(r2.status, 200, "6b. 带 answers 二轮 → 200");
      assertEq(r2.data?.analysis?.clarificationRequired, false, "6b. 二轮不再追问");
      assertEq(r2.data?.analysis?.clarificationQuestions?.length, 0, "6b. 二轮问题为空");
      assertEq(r2.data?.enhancedText, finalEnhance.enhancedText, "6b. 二轮拿到最终增强结果");

      const calls = mock.captured().slice(beforeCount).filter((c) => c.url.endsWith("/chat/completions") && c.body.includes("json_object"));
      assertEq(calls.length, 2, "6b. 追问闭环累计 2 次上游调用");
      ok(calls[1].body.includes("预算 10 万"), "6b. 二轮请求体并入答案");
    }

    // 6c. clarificationMode=off：问题被过滤为空（1 次调用）；语义标记仍按程序派生，
    //     是否展示追问 UI 由控制器 Clarification Gate（off→不展示）决定。
    {
      mock.setEnhanceSequence([askEnhance]);
      const beforeCount = mock.requestCount();
      const r = await httpJson(PORT, "POST", "/v1/enhance", {
        token: TOKEN,
        body: { originalText: "写产品推广方案", taskType: "auto", enhanceLevel: "deep", clarificationMode: "off" },
        timeoutMs: 5000,
      });
      assertEq(r.status, 200, "6c. off → 200");
      assertEq(r.data?.analysis?.clarificationQuestions?.length, 0, "6c. off 强制问题为空");
      const calls = mock.captured().slice(beforeCount).filter((c) => c.url.endsWith("/chat/completions") && c.body.includes("json_object"));
      assertEq(calls.length, 1, "6c. off 模式 1 次调用");
      ok(!JSON.stringify(r.data).includes(secretKey), "6c. 响应不含 Key");
    }

    // 6d. 结构化失败：可修复（text-fallback）或持续失败（passthrough 不丢输入）。
    {
      mock.setEnhanceSequence([finalEnhance]);
      mock.triggerGarbageOnce();
      const ar = await httpJson(PORT, "POST", "/v1/enhance", {
        token: TOKEN,
        body: { originalText: "写产品推广方案", taskType: "auto", enhanceLevel: "deep", clarificationMode: "smart" },
        timeoutMs: 5000,
      });
      assertEq(ar.status, 200, "6d-A. 可修复路径 HTTP 200");
      assertEq(ar.data?.fallback, "text-fallback", "6d-A. 首次失败 → 重试成功，标记 text-fallback");
      assertEq(ar.data?.analysis?.scoreSource, "heuristic_fallback", "6d-A. 结构化缺失 → 评分降级 heuristic_fallback");
      ok(!JSON.stringify(ar.data).includes(secretKey), "6d-A. 响应不含 Key");

      // 修复 C 生效验证：纯文本模式（plain）返回合法纯文本 → textFallback 成功降级
      //（修复前：jsonMode 未贯穿响应解析，纯文本被误判 JSON 解析失败 → passthrough）。
      mock.setMode("plain");
      const br = await httpJson(PORT, "POST", "/v1/enhance", {
        token: TOKEN,
        body: { originalText: "写产品推广方案", taskType: "auto", enhanceLevel: "deep", clarificationMode: "smart" },
        timeoutMs: 5000,
      });
      assertEq(br.status, 200, "6d-B. 持续失败仍 HTTP 200（安全降级）");
      assertEq(br.data?.fallback, "text-fallback", "6d-B. 纯文本降级成功（jsonMode=false 真正生效）");
      assertEq(br.data?.analysis?.scoreSource, "heuristic_fallback", "6d-B. 降级评分 heuristic_fallback");
      ok(br.data?.enhancedText?.includes("推广方案"), "6d-B. 纯文本增强保留核心意图（非原文透传）");
      mock.setMode("ok");
    }

    // 6e. 无默认 Provider → 明确 INVALID_REQUEST + 原文透传（passthrough 不丢输入）。
    {
      await httpJson(PORT, "DELETE", "/v1/providers/final-openai", { token: TOKEN });
      const nr = await httpJson(PORT, "POST", "/v1/enhance", {
        token: TOKEN,
        body: { originalText: "写产品推广方案", taskType: "auto", enhanceLevel: "deep", clarificationMode: "smart" },
        timeoutMs: 5000,
      });
      assertEq(nr.status, 200, "6e. 无默认 Provider → HTTP 200（体内错误）");
      assertEq(nr.data?.error?.code, "INVALID_REQUEST", "6e. 错误码 INVALID_REQUEST");
      ok((nr.data?.error?.message ?? "").includes("Provider"), "6e. 明确提示未配置 Provider");
      assertEq(nr.data?.enhancedText, "写产品推广方案", "6e. 原文透传");
      assertEq(nr.data?.fallback, "passthrough", "6e. fallback 标记 passthrough");
    }

    // 6f. 空文本 → 400。
    {
      const er = await httpJson(PORT, "POST", "/v1/enhance", {
        token: TOKEN,
        body: { originalText: "", taskType: "auto", enhanceLevel: "deep", clarificationMode: "smart" },
      });
      assertEq(er.status, 400, "6f. 空文本 → 400");
    }
  }

  // ── 7. /v1/analyze 离线启发式（不调用模型） ─────────
  {
    const beforeCount = mock.requestCount();
    const r = await httpJson(PORT, "POST", "/v1/analyze", {
      token: TOKEN,
      body: { originalText: "帮我写一个产品推广方案", taskType: "auto", enhanceLevel: "deep", clarificationMode: "smart" },
    });
    assertEq(r.status, 200, "7. /v1/analyze → 200");
    assertEq(r.data?.scoreSource, "heuristic_fallback", "7. 离线评分 scoreSource=heuristic_fallback");
    ok(r.data?.detectedTaskType, "7. 返回检测任务类型");
    ok(r.data?.totalScore >= 0 && r.data?.totalScore <= 100, "7. 总分在 0–100");
    assertEq(r.data?.clarificationRequired, false, "7. analyze 不触发追问（离线启发式）");
    const calls = mock.captured().slice(beforeCount).filter((c) => c.url.endsWith("/chat/completions"));
    assertEq(calls.length, 0, "7. 离线评分不调用模型");
  }

  // ── 清理 ────────────────────────────────────────────
  console.log("== 清理 ==");
  await cleanup();

  // 8a. 端口已关闭。
  let portOpen = false;
  try {
    const r = await httpJson(PORT, "GET", "/health", { timeoutMs: 1500 });
    if (r.status) portOpen = true;
  } catch { portOpen = false; }
  ok(!portOpen, "8a. 服务端口已关闭（拒绝连接）");
  ok(!existsSync(tmpDir), "8a. 临时目录已删除");

  // 8b. 真实 data/ 不变。
  const after = snapshotRealData();
  const unchanged = after === before;
  ok(unchanged, "8b. 真实 data/ hash+mtime 前后一致");
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
