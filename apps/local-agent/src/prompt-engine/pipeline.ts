/**
 * Prompt Engine 管线编排（阶段 5 核心）。
 *
 * 一次 LLM 调用完成：分类 + 评分 + 追问判断 + 增强。
 *
 * 流程：
 *   1. 构建 system（元提示）与 user（原文 + 任务定义 + 强度定义 + 场景补强 + 追问答案）。
 *   2. 调用 Provider.enhancePrompt → 单块 JSON。
 *   3. 程序校验并组装：
 *      - detectedTaskType / 评分维度经 sanitize 限制；
 *      - totalScore 由 computeTotalScore 计算（模型不直接决定总分）；
 *      - scoreSource: "llm"。
 *   4. 结构化失败可修复/降级（fail-open）：
 *      a. JSON 解析失败 → 纯文本重试一次（仍增强，但无结构化 analysis）。
 *      b. 纯文本也失败（含空/不可读）→ 原样返回原文 + heuristic 分析。
 *
 * 意图保真：meta-prompt 强制保留核心动作/目标；管线层再校验增强文本
 * 不丢失原始核心词（去停用词后逐 token 校验）。
 */
import {
  ENHANCE_LEVELS,
  MAX_INPUT_LENGTH,
  TASK_TYPES,
  type EnhanceLevel,
  type EnhancePromptRequest,
  type PromptAnalysis,
  type TaskType,
} from "@prompt-boost/shared";
import { heuristicScore, sanitizeDimensions, computeTotalScore } from "@prompt-boost/prompt-core";
import { classifyTaskType } from "@prompt-boost/prompt-core";
import { createLogger, type Logger } from "../log.js";
import type { ModelProvider, ProviderEnhanceResult } from "../providers/types.js";
import { ProviderError } from "../providers/types.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildPlainFallbackSystemPrompt,
  buildPlainFallbackUserPrompt,
  type StrategyInput,
} from "./meta-prompt.js";

/** 增强结果（内部）：成功路径带 analysis，降级路径带降级标记。 */
export interface EnhanceOutcome {
  enhancedText: string;
  analysis: PromptAnalysis | null;
  assumptions: string[];
  /** 降级标记：null=完整成功；"text-fallback"=结构化失败后的纯文本增强；"passthrough"=原样返回。 */
  fallback: "text-fallback" | "passthrough" | null;
  provider: string;
  model: string;
}

const STOPWORDS = new Set([
  "的", "了", "是", "我", "你", "他", "她", "它", "们", "把", "被", "让", "给",
  "这", "那", "在", "有", "和", "与", "及", "或", "也", "就", "都", "而", "并",
  "请", "帮", "要", "会", "能", "为", "对", "从", "到", "向", "将", "着", "过",
  "一个", "一下", "然后", "所以", "因为", "但是", "如果", "可以", "需要",
  // 无实义单字：数词/量词、泛任务动词、介词。过滤后意图保真只校验概念词，
  // 避免「帮我写一个产品推广方案」被模型改写为近义词（如「撰写市场宣传计划」）
  // 时按字爆量误报；而实义概念（狗/猫、Python、方案）仍会被拦截。
  "一", "个", "首", "份", "篇", "次", "段", "款",
  "写", "做", "发", "想", "求", "用", "弄", "搞", "于",
  "the", "a", "an", "is", "are", "was", "were", "to", "for", "of", "in", "on",
  "and", "or", "but", "with", "you", "i", "please", "help", "write", "make",
  "can", "could", "would", "should", "will", "that", "this", "these", "those",
]);

/**
 * 把文本切分为「意图核心词」token。
 *
 * 中文不做字级切分（字级切分 + 后续 length>=2 过滤会让纯中文输入的核心词恒空，
 * 意图保真 gate 失效）。这里按「词级」处理：
 * - 连续汉字按相邻单字逐字保留（每个字是一个 token）——无词典前提下，宁可保守
 *   也不丢弃实义单字；停用词（的/了/是…）在 tokenize 里被过滤。
 * - 连续英文字母数字作为整体 token。
 * - 停用词（含常见中文虚词/助词）整体过滤。
 *
 * 这样 "写一首关于狗的诗" → ["写","首","关于","狗","诗"]（"一首/关于" 为双字词），
 * "狗" 成为核心 token，模型若改写为 "猫" 会被 missingCoreTokens 拦截。
 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = lower.match(/[㐀-鿿]|[a-z0-9]+/g) ?? [];
  return tokens.filter((t) => !STOPWORDS.has(t) && t.trim().length > 0);
}

/** CJK 单字（与 tokenize 同一范围：含扩展 A 区）。 */
const CJK_CHAR = /[㐀-鿿]/;

/**
 * 核心意图保真校验：增强文本不得丢失原始 Prompt 的核心词。
 * 忽略停用词；原始 Prompt 中重要的中文单字/词与英文字母数字串都应保留。
 * 返回被丢失的核心词（空数组 = 通过）。
 *
 * 中文按单字 token 校验，但「连续缺失的汉字」合并为单个短语 token：
 * 模型用近义词改写整词（如「推广方案」→「市场宣传计划」）时，按字会爆量误报
 * （4 个字 = 4 个缺失），合并后视为一次近义词改写（1 个缺失，允许）。
 * 若增强文本整体丢失某概念（如「狗」改写为「猫」），仍会进入缺失列表。
 */
export function missingCoreTokens(original: string, enhanced: string): string[] {
  const enhancedSet = new Set(tokenize(enhanced));
  const core = tokenize(original);
  const missing: string[] = [];
  const seen = new Set<string>();
  // 当前连续缺失的汉字段（近义词改写的整词）。
  let run = "";
  const flush = (): void => {
    if (run && !seen.has(run)) {
      missing.push(run);
      seen.add(run);
    }
    run = "";
  };
  for (const t of core) {
    if (enhancedSet.has(t)) {
      flush();
      continue;
    }
    if (CJK_CHAR.test(t)) {
      run += t; // 汉字缺失：并入当前短语段。
    } else {
      // 英文/数字缺失：独立计入（不做合并）。
      flush();
      if (!seen.has(t)) {
        missing.push(t);
        seen.add(t);
      }
    }
  }
  flush();
  return missing;
}

/** 把 ProviderEnhanceResult.analysis 与程序计算的总分组装为完整 PromptAnalysis。 */
function toAnalysis(
  detectedTaskType: string,
  scoreDimensions: Record<string, number>,
  missingInformation: string[],
  criticalMissingInformation: string[],
  suggestions: string[],
  confidence: number | undefined,
  scoreSource: "llm" | "heuristic_fallback",
  clarificationRequired = false,
  clarificationQuestions: PromptAnalysis["clarificationQuestions"] = [],
): PromptAnalysis {
  const dims = sanitizeDimensions(scoreDimensions);
  const taskType: TaskType = TASK_TYPES.includes(detectedTaskType as TaskType)
    ? (detectedTaskType as TaskType)
    : "general";
  const clampStrings = (values: string[], maxItems: number, maxLength: number): string[] =>
    values
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim().slice(0, maxLength))
      .filter(Boolean)
      .slice(0, maxItems);
  const safeQuestions = clarificationQuestions
    .map((item, index) => ({
      id: (item.id || `q${index + 1}`).slice(0, 64),
      question: item.question.trim().slice(0, 200),
      reason: (item.reason.trim() || "补充关键信息").slice(0, 200),
      required: Boolean(item.required),
    }))
    .filter((item) => item.question.length > 0)
    .slice(0, 3);
  return {
    detectedTaskType: taskType,
    // confidence 必须 clamp 到 [0,1]：模型可能返回越界值（如 1.5），
    // 扩展端 zod 校验（confidence 0..1）会失败丢单。
    confidence: Math.min(1, Math.max(0, confidence ?? 0)),
    scoreDimensions: dims,
    totalScore: computeTotalScore(dims),
    scoreSource,
    missingInformation: clampStrings(missingInformation, 8, 200),
    criticalMissingInformation: clampStrings(criticalMissingInformation, 8, 200),
    suggestions: clampStrings(suggestions, 6, 500),
    clarificationRequired,
    clarificationQuestions: safeQuestions,
  };
}

/** 判断 LLM 输出是否可接受（核心意图保真 + 非空）。 */
function isAcceptable(text: string, original: string): boolean {
  if (!text || !text.trim()) return false;
  if (text === original) return false; // 完全没有改动，视为失败（避免无意义返回原文）。
  const missing = missingCoreTokens(original, text);
  // 允许最多丢失 1 个核心词（模型可能改写近义词）；丢失 ≥2 视为意图丢失。
  return missing.length <= 1;
}

/**
 * 按追问模式过滤 LLM 产出的追问问题：
 * - off：恒不追问。
 * - 已提供追问答案（第二次增强）：不再追问，直接用首轮结果。
 * - smart / always：透传 LLM 产出的问题（最多 3 个）。
 */
/**
 * 按追问模式过滤 LLM 产出的追问问题。
 * 仅在结构化路径调用（out 非空，runEnhance 首轮已对 null 走降级）。
 */
function clarificationForMode(
  out: ProviderEnhanceResult["analysis"],
  input: StrategyInput,
): PromptAnalysis["clarificationQuestions"] {
  if (input.clarificationMode === "off") return [];
  const hasAnswers =
    input.clarificationAnswers && Object.values(input.clarificationAnswers).some((v) => v && v.trim());
  if (hasAnswers) return [];
  return (out?.clarificationQuestions ?? []).slice(0, 3);
}
/** 把 LLM 返回文本的意图保真校验结果（供日志与测试使用）。 */
export function intentOk(original: string, enhanced: string): boolean {
  return isAcceptable(enhanced, original);
}

export interface EnhancePipelineDeps {
  provider: ModelProvider;
  providerLabel: string; // 形如 "openai/gpt-4o-mini"
  logger?: Logger;
  /** 客户端断连信号：中止时取消上游 LLM 调用（避免孤儿请求继续消耗额度）。 */
  signal?: AbortSignal;
}

/**
 * 执行增强管线。抛出 ProviderError 表示 Provider 层失败（由路由层映射）。
 * 解析失败不抛出，走降级路径。
 */
export async function runEnhance(
  request: EnhancePromptRequest,
  deps: EnhancePipelineDeps,
): Promise<EnhanceOutcome> {
  const log = deps.logger ?? createLogger(false);
  const level: EnhanceLevel = ENHANCE_LEVELS.includes(
    request.enhanceLevel as EnhanceLevel,
  )
    ? (request.enhanceLevel as EnhanceLevel)
    : "deep";

  const input: StrategyInput = {
    originalText: request.originalText,
    taskType: request.taskType ?? "auto",
    enhanceLevel: level,
    clarificationMode: request.clarificationMode ?? "smart",
    clarificationAnswers: request.clarificationAnswers,
    outputLanguage: request.outputLanguage,
  };

  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(input);

  // ── 第一次尝试：JSON 结构化。 ───────────────────────────
  try {
    const result = await deps.provider.enhancePrompt({
      systemPrompt,
      userPrompt,
      originalText: request.originalText,
      taskType: input.taskType,
      enhanceLevel: level,
      clarificationMode: input.clarificationMode,
      outputLanguage: input.outputLanguage,
    }, { signal: deps.signal });

    const out = result.analysis;
    // 首轮调用不传 jsonMode（默认 true，结构化 JSON 模式），analysis 保证非空；
    // 仅 textFallback 的 jsonMode:false 请求允许 analysis 为 null。
    if (!out) return await textFallback(request, input, deps);
    // 越界截断：增强文本超过扩展端 zod 上限（MAX_INPUT_LENGTH）会被校验拒绝丢单。
    const enhanced = result.enhancedText.slice(0, MAX_INPUT_LENGTH);
    const missing = missingCoreTokens(request.originalText, enhanced);
    if (enhanced.trim() && missing.length <= 1) {
      log.debug(`enhance: structured ok (provider=${deps.providerLabel}, missingCore=${missing.length})`);
      const questions = clarificationForMode(out, input);
      const critical = out.criticalMissingInformation ?? [];
      // 程序侧 Gate（模型只负责语义：产出 criticalMissingInformation 与问题）。
      // clarificationRequired 由程序派生，不直接信任模型自评布尔值。
      const clarificationRequired = critical.length > 0;
      return {
        enhancedText: enhanced,
        analysis: toAnalysis(
          out.detectedTaskType,
          out.scoreDimensions,
          out.missingInformation,
          critical,
          out.suggestions,
          out.confidence,
          "llm",
          clarificationRequired,
          questions,
        ),
        assumptions: (result.assumptions ?? [])
          .map((item) => item.trim().slice(0, 300))
          .filter(Boolean)
          .slice(0, 3),
        fallback: null,
        provider: deps.providerLabel.slice(0, 128),
        model: deps.provider.config.model,
      };
    }
    // 结构化结果可用但意图丢失：仍走一次纯文本降级（见下），尽量保留意图。
    log.warn(`enhance: structured ok but intent lost (missingCore=${missing.length})`);
    return await textFallback(request, input, deps);
  } catch (err) {
    // Provider 层错误（超时/限流/网络/API Key 等）直接上抛，不降级为纯文本。
    // 只有「解析/校验」类失败（RESPONSE_INVALID）才进入降级路径。
    if (err instanceof ProviderError && err.code === "RESPONSE_INVALID") {
      log.warn(`enhance: structured parse failed (${err.safeMessage}); text fallback`);
      return await textFallback(request, input, deps);
    }
    throw err;
  }
}

/** 纯文本降级：再调用一次（不要求 JSON），仍失败则原样返回。 */
async function textFallback(
  request: EnhancePromptRequest,
  input: StrategyInput,
  deps: EnhancePipelineDeps,
): Promise<EnhanceOutcome> {
  const log = deps.logger ?? createLogger(false);

  try {
    // 纯文本降级：用 jsonMode=false 请求（不注入 response_format），
    // 让 provider 真正走纯文本模式，而非再次带 JSON 强约束重试。
    const result = await deps.provider.enhancePrompt({
      systemPrompt: buildPlainFallbackSystemPrompt(),
      userPrompt: buildPlainFallbackUserPrompt(input),
      originalText: request.originalText,
      taskType: input.taskType,
      enhanceLevel: input.enhanceLevel,
      clarificationMode: input.clarificationMode,
      outputLanguage: input.outputLanguage,
    }, { signal: deps.signal, jsonMode: false });
    // 纯文本降级同样截断越界输出（避免扩展端 zod 拒绝）。
    const enhanced = result.enhancedText.trim().slice(0, MAX_INPUT_LENGTH);
    if (!looksLikeEnhanceEnvelope(enhanced) && isAcceptable(enhanced, request.originalText)) {
      const heuristic = heuristicScore(request.originalText);
      const classified = classifyTaskType(request.originalText);
      return {
        enhancedText: enhanced,
        analysis: toAnalysis(
          classified.taskType,
          heuristic.dimensions,
          heuristic.missing,
          [],
          heuristic.suggestions,
          classified.confidence,
          "heuristic_fallback",
        ),
        assumptions: [],
        fallback: "text-fallback",
        provider: deps.providerLabel.slice(0, 128),
        model: deps.provider.config.model,
      };
    }
    log.warn("enhance: text fallback empty; passthrough original");
    return await passthrough(request, deps);
  } catch (err) {
    log.warn(`enhance: text fallback failed (${err instanceof ProviderError ? err.safeMessage : String(err)}); passthrough original`);
    return await passthrough(request, deps);
  }
}

/** 只拦截结构化增强协议外壳，不误伤用户本来就需要优化的普通 JSON Prompt。 */
function looksLikeEnhanceEnvelope(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const object = parsed as Record<string, unknown>;
    return (
      typeof object.enhancedText === "string" &&
      ("reasoning" in object || "scoreDimensions" in object || "detectedTaskType" in object)
    );
  } catch {
    return false;
  }
}

/** 原样返回（安全降级）：绝不丢用户输入。 */
async function passthrough(
  request: EnhancePromptRequest,
  deps: EnhancePipelineDeps,
): Promise<EnhanceOutcome> {
  const heuristic = heuristicScore(request.originalText);
  const classified = classifyTaskType(request.originalText);
  return {
    enhancedText: request.originalText,
    analysis: {
      detectedTaskType: classified.taskType,
      confidence: classified.confidence,
      scoreDimensions: heuristic.dimensions,
      totalScore: heuristic.total,
      scoreSource: "heuristic_fallback",
      missingInformation: heuristic.missing,
      criticalMissingInformation: [],
      suggestions: heuristic.suggestions,
      clarificationRequired: false,
      clarificationQuestions: [],
    },
    assumptions: [],
    fallback: "passthrough",
    provider: deps.providerLabel.slice(0, 128),
    model: deps.provider.config.model,
  };
}
