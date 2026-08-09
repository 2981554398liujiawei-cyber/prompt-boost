/**
 * Provider 错误模型与统一接口。
 *
 * 设计：
 * - UI / HTTP Route / Prompt Engine 只依赖本模块的类型，不直接依赖具体 SDK。
 * - 所有 Provider 实现返回内部统一结果，不向上层泄露 SDK 对象。
 * - ProviderError 保留内部 cause 便于调试，但对外只暴露 safeMessage。
 */
import type {
  ConnectionTestResult,
  ProviderConfig,
  ProviderRequestOptions,
  TaskType,
} from "@prompt-boost/shared";
import { TASK_TYPES } from "@prompt-boost/shared";

export const PROVIDER_ERROR_CODES = [
  "INVALID_API_KEY",
  "INSUFFICIENT_QUOTA",
  "RATE_LIMITED",
  "MODEL_NOT_FOUND",
  "INVALID_REQUEST",
  "CONNECTION_FAILED",
  "TIMEOUT",
  "RESPONSE_INVALID",
  "PROVIDER_UNAVAILABLE",
  "UNKNOWN",
] as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

export interface ProviderErrorOptions {
  code: ProviderErrorCode;
  providerType: string;
  /** HTTP 状态码（若有）。 */
  status?: number;
  /** 是否可重试（429、超时、连接失败等）。 */
  retryable: boolean;
  /** 对外安全消息（不泄露 Key / 请求头 / SDK 响应）。 */
  safeMessage: string;
  /** 内部原因，仅调试用。 */
  cause?: unknown;
}

/** 统一 Provider 错误。HTTP 层只序列化 safeMessage。 */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly providerType: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly cause?: unknown;

  constructor(opts: ProviderErrorOptions) {
    super(opts.safeMessage);
    this.name = "ProviderError";
    this.code = opts.code;
    this.providerType = opts.providerType;
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.safeMessage = opts.safeMessage;
    this.cause = opts.cause;
  }

  /** 转换为对外安全的错误对象（只含 code/message）。 */
  toSafeError(): { code: ProviderErrorCode; message: string } {
    return { code: this.code, message: this.safeMessage };
  }
}

/** 分析请求（Provider 层视角）。prompt-engine 已把分类/评分/追问/增强并入单次调用。 */
export interface AnalyzePromptRequest {
  /** system 元提示（由 prompt-engine 构建；含输出 JSON 契约）。 */
  systemPrompt: string;
  /** user 文案（原始 Prompt + 任务定义 + 增强强度 + 追问答案）。 */
  userPrompt: string;
  /** 备选：直接给出原始 Prompt（纯文本模式降级时使用）。 */
  originalText: string;
  taskType: string;
  enhanceLevel: string;
  clarificationMode: string;
  outputLanguage?: string;
}

/** 单块 JSON 增强输出的内部结构（prompt-engine 与 provider 共享契约）。 */
export interface EnhanceJsonOutput {
  enhancedText: string;
  reasoning: string;
  assumptions: string[];
  originalIntent: string;
  detectedTaskType: string;
  scoreDimensions: Record<string, number>;
  missingInformation: string[];
  /** 关键缺失信息：缺失会显著改变最终 Prompt 的目标/对象/策略/约束/输出（Clarification Gate 的输入）。 */
  criticalMissingInformation: string[];
  suggestions: string[];
  confidence?: number;
  /** 是否需要追问（smart/always 时由 LLM 判定）。 */
  clarificationRequired?: boolean;
  /** 追问问题（最多 3 个）。 */
  clarificationQuestions?: Array<{
    id: string;
    question: string;
    reason: string;
    required: boolean;
  }>;
}

/**
 * 把 LLM 返回的文本解析为 ProviderEnhanceResult。
 * - 需要内置维度解析逻辑（sanitizeDimensions/computeTotalScore 走 prompt-core），
 *   因此由引擎层调用 parseEnhanceJsonOutput 后再组装。
 */
export function parseEnhanceJsonOutput(text: string, providerType: string): EnhanceJsonOutput {
  const parsed = tryParseJsonObject(text);
  if (!parsed) {
    throw new ProviderError({
      code: "RESPONSE_INVALID",
      providerType,
      retryable: false,
      safeMessage: "Provider 返回了无法解析的 JSON",
    });
  }
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : "")).filter(Boolean) : [];
  const dims = (v: unknown): Record<string, number> => {
    const out: Record<string, number> = {};
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
      }
    }
    return out;
  };
  const questions = (v: unknown): Array<{ id: string; question: string; reason: string; required: boolean }> => {
    if (!Array.isArray(v)) return [];
    const out: Array<{ id: string; question: string; reason: string; required: boolean }> = [];
    for (const q of v.slice(0, 3)) {
      if (!q || typeof q !== "object") continue;
      const o = q as Record<string, unknown>;
      const question = typeof o.question === "string" && o.question.trim() ? o.question.trim() : "";
      if (!question) continue;
      out.push({
        id: typeof o.id === "string" && o.id ? o.id : `q${out.length + 1}`,
        question: question.slice(0, 200),
        reason: typeof o.reason === "string" ? o.reason.slice(0, 200) : "",
        required: typeof o.required === "boolean" ? o.required : false,
      });
    }
    return out;
  };
  return {
    enhancedText: str(parsed.enhancedText),
    reasoning: str(parsed.reasoning),
    assumptions: arr(parsed.assumptions),
    originalIntent: str(parsed.originalIntent),
    detectedTaskType: str(parsed.detectedTaskType),
    scoreDimensions: dims(parsed.scoreDimensions),
    missingInformation: arr(parsed.missingInformation),
    criticalMissingInformation: arr(parsed.criticalMissingInformation),
    suggestions: arr(parsed.suggestions),
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
    clarificationRequired: typeof parsed.clarificationRequired === "boolean" ? parsed.clarificationRequired : false,
    clarificationQuestions: questions(parsed.clarificationQuestions),
  };
}

/** 把 LLM 返回的文本解析为 ProviderAnalyzeResult（score 字段由引擎层计算）。 */
export function parseProviderAnalyzeResult(
  text: string,
  providerType: string,
): ProviderAnalyzeResult {
  const out = parseEnhanceJsonOutput(text, providerType);
  const taskType = TASK_TYPES.includes(out.detectedTaskType as TaskType)
    ? (out.detectedTaskType as TaskType)
    : "general";
  return {
    detectedTaskType: taskType,
    confidence: out.confidence ?? 0,
    scoreDimensions: out.scoreDimensions,
    totalScore: 0,
    scoreSource: "llm",
    missingInformation: out.missingInformation,
    criticalMissingInformation: out.criticalMissingInformation ?? [],
    suggestions: out.suggestions,
    clarificationRequired: out.clarificationRequired ?? false,
    clarificationQuestions: out.clarificationQuestions ?? [],
  };
}

/** 把 LLM 返回的文本解析为 ProviderEnhanceResult。 */
export function parseProviderEnhanceResultForCompose(
  text: string,
  providerType: string,
): ProviderEnhanceResult {
  const out = parseEnhanceJsonOutput(text, providerType);
  return {
    enhancedText: out.enhancedText,
    analysis: parseProviderAnalyzeResult(text, providerType),
    assumptions: out.assumptions,
  };
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fence ? fence[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(candidate.slice(start, end + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** Provider 分析返回。 */
export interface ProviderAnalyzeResult {
  detectedTaskType: string;
  confidence: number;
  scoreDimensions: Record<string, number>;
  /** 加权总分（0–100，程序计算，模型不直接决定）。 */
  totalScore: number;
  /** 评分来源：llm / heuristic_fallback。 */
  scoreSource: "llm" | "heuristic_fallback";
  missingInformation: string[];
  /** 关键缺失信息（Clarification Gate 的输入）。 */
  criticalMissingInformation: string[];
  suggestions: string[];
  clarificationRequired: boolean;
  clarificationQuestions: Array<{
    id: string;
    question: string;
    reason: string;
    required: boolean;
  }>;
}

/** Provider 增强返回。 */
export interface ProviderEnhanceResult {
  enhancedText: string;
  /**
   * 结构化分析（JSON 模式）；jsonMode=false（纯文本降级）时为 null，
   * 由管线层用离线启发式补全 analysis。
   */
  analysis: ProviderAnalyzeResult | null;
  assumptions: string[];
}

/** 统一 ModelProvider 接口。 */
export interface ModelProvider {
  readonly type: string;
  readonly config: ProviderConfig;
  testConnection(): Promise<ConnectionTestResult>;
  /**
   * 拉取可用模型 ID 列表（OpenAI /models、Anthropic /v1/models 等）。
   * 失败抛 ProviderError（由路由层映射为统一安全错误）。
   */
  listModels(): Promise<string[]>;
  analyzePrompt(
    request: AnalyzePromptRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderAnalyzeResult>;
  enhancePrompt(
    request: AnalyzePromptRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderEnhanceResult>;
}

/** 创建 Provider 所需的运行时依赖（配置 + API Key）。 */
export interface ProviderContext {
  config: ProviderConfig;
  apiKey: string;
  baseUrl?: string;
}
