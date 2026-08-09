// 一次性测量：用现网真实完整 prompt，直连 PackyAPI 裸调 deepseek-v4-flash。
import { createDecipheriv, pbkdf2Sync, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dataDir = "apps/local-agent/data";
const master = readFileSync(join(dataDir, ".vault-master-key"), "utf8").trim();
const salt = createHash("sha256").update("prompt-boost-vault-v1").digest();
const mk = pbkdf2Sync(master, salt, 210_000, 32, "sha256");
const vault = JSON.parse(readFileSync(join(dataDir, "vault.enc.json"), "utf8"));
const dec = (e) => {
  const d = createDecipheriv("aes-256-gcm", mk, Buffer.from(e.iv, "hex"));
  d.setAuthTag(Buffer.from(e.tag, "hex"));
  return Buffer.concat([d.update(Buffer.from(e.data, "hex")), d.final()]).toString("utf8");
};
const apiKey = dec(vault.entries["providerKey:packyapi"]);
const BASE = "https://www.packyapi.ai/v1";

// 从代码复刻真实完整 prompt（system 含 JSON 契约 + user 含任务定义/强度/原文）
const sysReal = [
  "你是一个专业的 Prompt 增强引擎。你的任务是：把用户写好的 Prompt 改写得更完整、更清晰、更具可执行性。",
  "【最关键规则】你输出的必须是「增强后的 Prompt」本身，绝对不要替用户执行他们的任务。",
  "【原始意图保真】改写时保留用户原始 Prompt 的核心动作、目标、领域与所有具体细节；只补强结构与表达，绝不改变用户的核心诉求，也不要为了显得专业而无意义地膨胀。",
  "【评分】对用户的「原始 Prompt」按 8 个维度打分（每维 0–100）：objective 目标清晰度、context 上下文充分性、audience 受众明确性、outputFormat 输出格式、constraints 限制条件、role 角色视角、materials 数据素材、actionability 可执行性。不要对增强后的 Prompt 打分。",
  "【追问】当原始 Prompt 缺失会显著改变最终 Prompt 的目标、对象、策略、约束或输出的关键信息时，**必须**产出 1–3 个追问问题（不是自行假设）。",
  "【输出】只输出一个 JSON 对象，不要输出任何其它文字。",
  'JSON 结构：{"enhancedText": "…", "reasoning": "…", "assumptions": ["…"], "originalIntent": "…", "detectedTaskType": "…", "scoreDimensions": {"objective": 0, "context": 0, "audience": 0, "outputFormat": 0, "constraints": 0, "role": 0, "materials": 0, "actionability": 0}, "missingInformation": ["…"], "criticalMissingInformation": ["…"], "suggestions": ["…"], "confidence": 0, "clarificationRequired": false, "clarificationQuestions": []}',
  "字段说明：enhancedText：增强后的 Prompt（这是要写回输入框的内容）。reasoning：你对增强理由的简短说明。assumptions：你补全时所做的假设（最多 3 条）。originalIntent：用一句话概括用户原始意图。detectedTaskType：检测到的任务类型。scoreDimensions：对原始 Prompt 的 8 维评分。missingInformation：原始 Prompt 缺失的关键信息。criticalMissingInformation：会显著改变最终 Prompt 目标/对象/策略/约束/输出的关键缺失信息。若无则为空数组。suggestions：对原始 Prompt 的优化建议。confidence：你对任务类型判断的置信度（0–1）。clarificationRequired：是否需要追问（boolean）。clarificationQuestions：追问问题数组，每项含 {id, question, reason, required}，最多 3 个。",
].join("\n");

const usrReal = [
  "任务类型（detectedTaskType 取值，必须用其中之一）：writing/coding/business/analysis/research/learning/translation/planning/creative/general。",
  "【当前增强强度：deep 深度】中等重写：在保留原文核心诉求的前提下，补充背景、受众、输出格式、限制条件、角色、素材、步骤等缺失要素。输出长度控制在原文的 1.3–1.8 倍。重写要自然、聚焦，避免为凑长度而重复。",
  "【输出语言】跟随用户原始 Prompt 的语言输出。",
  "【追问策略】智能追问：缺失会显著改变最终 Prompt 的目标/对象/策略/约束/输出的关键信息时，**必须**产出追问问题（不是自行假设）；信息足够则 clarificationRequired 为 false。",
  "【场景补强原则】在改写时按需应用以下补强（不要机械地全部套用，缺什么补什么）；注意：关键信息缺失时优先追问，而不是用假设硬补）：",
  "- 用清晰的动词明确你希望 AI 执行的步骤（分析 / 生成 / 对比 / 总结…）。",
  "- 把一个大任务拆成可执行的子步骤。",
  "- 明确输出格式：表格 / 列表 / JSON / Markdown / 代码 / 字数范围。",
  "- 明确产出给谁看：客户 / 团队 / 读者 / 非技术用户…，并说明受众关注点。",
  "- 补充约束：时间、预算、字数、风格、技术栈、禁止事项。",
  "- 指定一个对任务有帮助的视角，例如「你是一名资深产品经理」「你是一名资深后端工程师」。",
  "- 若任务依赖特定信息，提示需要提供数据、文档或示例输入。",
  "【用户原始 Prompt】",
  "```",
  "帮我写一个产品推广方案",
  "```",
  "请根据以上内容，输出增强后的 Prompt 与结构化分析（JSON）。",
].join("\n");

async function call(label, { maxTokens, stream }) {
  const body = { model: "deepseek-v4-flash", messages: [{ role: "system", content: sysReal }, { role: "user", content: usrReal }], response_format: { type: "json_object" } };
  if (maxTokens) body.max_tokens = maxTokens;
  if (stream) body.stream = true;
  const t0 = Date.now();
  try {
    if (stream) {
      const res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
      let firstChunkMs = null;
      let chunks = 0;
      let full = "";
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (firstChunkMs === null) firstChunkMs = Date.now() - t0;
        chunks++;
        full += dec.decode(value, { stream: true });
      }
      console.log(`[${label}] total=${Date.now() - t0}ms | firstChunk=${firstChunkMs}ms | chunks=${chunks} | bytes=${full.length}`);
    } else {
      const res = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
      const data = await res.json();
      const dt = Date.now() - t0;
      const content = data.choices?.[0]?.message?.content ?? "";
      const reasoning = data.choices?.[0]?.message?.reasoning_content ?? "";
      console.log(`[${label}] ${dt}ms | status=${res.status} | content=${content.length}ch | reasoning=${reasoning.length}ch | usage=${JSON.stringify(data.usage ?? {})}`);
      if (res.status !== 200) console.log("  err:", JSON.stringify(data.error ?? data).slice(0, 300));
    }
  } catch (e) {
    console.log(`[${label}] FAILED ${Date.now() - t0}ms: ${e.message}`);
  }
}

// 真实完整 prompt + 无 max_tokens（模拟现网，但真实会 400？先看）
await call("real-full-no-maxtok", {});
// 完整 + max_tokens 1000（生成量上限）
await call("real-full-max1000", { maxTokens: 1000 });
// 完整 + max_tokens 1000 + stream（流式 TTFB）
await call("real-full-stream", { maxTokens: 1000, stream: true });
