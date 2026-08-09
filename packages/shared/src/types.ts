import type {
  BoostState,
  ClarificationMode,
  EnhanceLevel,
  ProviderType,
  ScoreDimensionKey,
  TaskType,
} from "./constants.js";

/** 用户设置（持久化在 chrome.storage / local-agent settings）。 */
export interface Settings {
  /** 增强等级，默认 deep。 */
  enhanceLevel: EnhanceLevel;
  /** 追问模式，默认 smart。 */
  clarificationMode: ClarificationMode;
  /** 任务类型，auto 表示自动识别。 */
  taskType: TaskType | "auto";
  /** 输出语言，auto 表示跟随用户原文。 */
  outputLanguage: string;
}

/** 任务识别结果。 */
export interface ClassificationResult {
  taskType: TaskType;
  confidence: number;
}

/** 评分维度分数（0–100 整数）。 */
export type ScoreDimensions = Record<ScoreDimensionKey, number>;

/** Prompt 质量评分结果。 */
export interface PromptScore {
  total: number;
  dimensions: ScoreDimensions;
  missing: string[];
  suggestions: string[];
}

/** 追问问题。 */
export interface ClarificationQuestion {
  id: string;
  question: string;
  reason: string;
  required: boolean;
}

/** 追问阶段的结果。 */
export interface ClarificationResult {
  questions: ClarificationQuestion[];
  answers: Record<string, string>;
}

/** 增强请求（扩展 → 本地服务）。 */
export interface EnhancePromptRequest {
  originalText: string;
  taskType: TaskType | "auto";
  enhanceLevel: EnhanceLevel;
  clarificationMode: ClarificationMode;
  clarificationAnswers?: Record<string, string>;
  outputLanguage?: string;
}

/** 分析请求（扩展 → 本地服务 POST /v1/analyze）。 */
export interface AnalyzePromptRequest {
  originalText: string;
  taskType?: TaskType | "auto";
  enhanceLevel?: EnhanceLevel;
  clarificationMode?: ClarificationMode;
  clarificationAnswers?: Record<string, string>;
  outputLanguage?: string;
}

/** 评分来源：llm（模型维度分，程序算总分）或 heuristic_fallback（离线降级）。 */
export type ScoreSource = "llm" | "heuristic_fallback";

/** 评分来源展示文案（面向用户，不暴露工程字段）。 */
export const SCORE_SOURCE_LABEL: Record<ScoreSource, string> = {
  llm: "AI 分析",
  heuristic_fallback: "本地估算",
};

/** 分析结果。 */
export interface PromptAnalysis {
  detectedTaskType: TaskType;
  confidence: number;
  scoreDimensions: ScoreDimensions;
  /** 加权总分（0–100，由程序 computeTotalScore 计算，模型不直接决定）。 */
  totalScore: number;
  /** 评分来源（决定展示层是否信任模型维度判断）。 */
  scoreSource: ScoreSource;
  missingInformation: string[];
  /** 会显著改变结果的关键缺失信息（澄清 Gate 据此判定）。 */
  criticalMissingInformation: string[];
  suggestions: string[];
  clarificationRequired: boolean;
  clarificationQuestions: ClarificationQuestion[];
}

/** 增强结果（本地服务 → 扩展）。 */
export interface EnhancePromptResponse {
  enhancedText: string;
  analysis: PromptAnalysis;
  assumptions: string[];
  provider: string;
  model: string;
}

/**
 * Provider 连接测试结果（本地服务 → 扩展）。
 * 字段由阶段 4 规格固定：success / providerId / providerType / model /
 * latencyMs（monotonic clock）/ checkedAt / error（仅安全消息）。
 */
export interface ConnectionTestResult {
  success: boolean;
  providerId: string;
  providerType: ProviderType;
  model: string;
  /** 往返耗时（毫秒，monotonic clock）。 */
  latencyMs: number;
  /** ISO 时间戳。 */
  checkedAt: string;
  /** 失败原因（仅对外安全消息；成功时为 null）。 */
  error?: { code: string; message: string } | null;
}

/** Provider 配置元数据（不含 API Key）。 */
export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  /** Base URL。openai 类型省略时用官方默认；openai-compatible 必填。 */
  baseUrl?: string;
  model: string;
  timeoutSeconds: number;
  customHeaders?: Record<string, string>;
  /**
   * 为支持 DeepSeek `thinking` 参数的 OpenAI-Compatible 网关关闭思考模式。
   * false 时不发送该扩展字段，保持对其它兼容网关的兼容性。
   */
  disableThinking?: boolean;
  enabled: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Provider 列表项摘要（API 返回，不含 API Key）。 */
export interface ProviderSummary {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl?: string;
  model: string;
  timeoutSeconds: number;
  customHeaders?: Record<string, string>;
  disableThinking?: boolean;
  enabled: boolean;
  apiKeyConfigured: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** 拉取模型列表结果（本地服务 → 扩展）。只含模型 ID，不含 Key。 */
export interface ProviderModelsResult {
  providerType: string;
  models: string[];
}

/**
 * 统一 Provider 请求选项。
 * signal 以结构类型声明，避免 shared 引入 DOM lib（node/browser 均可使用）。
 * addEventListener 用 any rest 参数（事件监听器的 bivariant 惯例），使真实的
 * DOM / Node AbortSignal 天然可赋给该结构类型。
 */
export interface AbortSignalLike {
  aborted: boolean;
  reason?: unknown;
  // 真实 DOM / Node AbortSignal 的 addEventListener/removeEventListener 参数签名不同，
  // 用 any rest 参数使其结构类型天然可赋给两者。事件监听是只读兼容点，不用 unknown（TS 会拒绝赋值）。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener?: (...args: any[]) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener?: (...args: any[]) => void;
}

export interface ProviderRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignalLike;
  /** 请求体是否注入 json_object 模式字段（response_format）。OpenAI 系支持；
   *  Anthropic Messages API 不识别该字段，恒为 false。缺省 true（结构化首轮）。 */
  jsonMode?: boolean;
}

/** 健康检查响应。 */
export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  time: number;
}

/** 错误响应（统一脱敏格式）。 */
export interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

/** Boost 状态机事件（content script 内部）。 */
export interface BoostStateEvent {
  state: BoostState;
  message?: string;
}

/** 扩展保存的非敏感配置。 */
export interface ExtensionSettings {
  providers: ProviderConfig[];
  activeProviderId?: string;
  localAgentUrl: string;
  localAgentToken?: string;
  defaultEnhanceLevel: EnhanceLevel;
  defaultClarificationMode: ClarificationMode;
  defaultTaskType: TaskType | "auto";
  outputLanguage: string;
}
