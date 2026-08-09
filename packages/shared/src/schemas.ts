import { z } from "zod";
import {
  CLARIFICATION_MODES,
  ENHANCE_LEVELS,
  LOCAL_AGENT_DEFAULT_PORT,
  MAX_CLARIFICATION_QUESTIONS,
  MAX_INPUT_LENGTH,
  MIN_INPUT_LENGTH,
  PROVIDER_TYPES,
  SCORE_DIMENSION_KEYS,
  TASK_TYPES,
} from "./constants.js";

/** 0–100 整数。 */
export const zScore = z.number().int().min(0).max(100);

export const zTaskType = z.enum(TASK_TYPES);
export const zTaskTypeOrAuto = zTaskType.or(z.literal("auto"));
export const zEnhanceLevel = z.enum(ENHANCE_LEVELS);
export const zClarificationMode = z.enum(CLARIFICATION_MODES);
export const zProviderType = z.enum(PROVIDER_TYPES);

export const zSettings = z.object({
  enhanceLevel: zEnhanceLevel.default("deep"),
  clarificationMode: zClarificationMode.default("smart"),
  taskType: zTaskTypeOrAuto.default("auto"),
  outputLanguage: z.string().min(1).max(64).default("auto"),
});

/**
 * 设置更新 schema：只允许已知字段、拒绝未知字段、拒绝非法枚举。
 * 注意：不使用 .default()/strip，确保非法值直接报错而非静默丢弃。
 */
export const zSettingsUpdate = z.object({
  enhanceLevel: zEnhanceLevel.optional(),
  clarificationMode: zClarificationMode.optional(),
  taskType: zTaskTypeOrAuto.optional(),
  outputLanguage: z.string().min(1).max(64).optional(),
}).strict();

const zHeaderValue = z
  .string()
  .min(1)
  .max(1024)
  // 禁止换行注入（CR/LF 会破坏 HTTP 头结构）。
  .refine((v) => !/[\r\n]/.test(v), { message: "Header 值不得包含换行符" });

/**
 * Provider 配置（创建/完整）。
 * baseUrl 可选：openai 类型省略时用官方默认；openai-compatible 必填（路由层校验）。
 */
export const zProviderConfig = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  type: zProviderType,
  baseUrl: z
    .string()
    .url()
    .max(512)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  model: z.string().min(1).max(128),
  timeoutSeconds: z.number().int().min(1).max(300).default(30),
  customHeaders: z
    .object({})
    .catchall(zHeaderValue)
    .optional(),
  disableThinking: z.boolean().default(false),
  enabled: z.boolean().default(true),
  createdAt: z.string().min(1).max(64).optional(),
  updatedAt: z.string().min(1).max(64).optional(),
});

/** Provider 更新（PUT）：全部可选，未提供的字段保留原值；apiKey 单独字段。 */
export const zProviderUpdate = z.object({
  name: z.string().min(1).max(64).optional(),
  type: zProviderType.optional(),
  baseUrl: z
    .string()
    .url()
    .max(512)
    .optional()
    .or(z.literal("").transform(() => undefined)),
  model: z.string().min(1).max(128).optional(),
  timeoutSeconds: z.number().int().min(1).max(300).optional(),
  customHeaders: z
    .object({})
    .catchall(zHeaderValue)
    .optional(),
  disableThinking: z.boolean().optional(),
  enabled: z.boolean().optional(),
}).strict();

/** Provider 创建/更新时可附带 apiKey（单独走 vault，不入配置表）。 */
export const zProviderUpsert = z.object({
  config: zProviderConfig,
  apiKey: z.string().min(1).max(4096).optional(),
});

/**
 * Provider 更新请求体（PUT）：部分字段更新 + 可选 apiKey。
 * 未提供的字段保留原值；apiKey 单独走 vault，不入配置表。
 */
export const zProviderUpdateRequest = zProviderUpdate
  .extend({ apiKey: z.string().min(1).max(4096).optional() })
  .strict();

export const zProviderTestRequest = z.object({
  config: zProviderConfig,
  apiKey: z.string().min(1).max(4096).optional(),
});

/** 拉取模型列表请求（POST /v1/providers/models）。与测试请求同形状。 */
export const zProviderModelsRequest = z.object({
  config: zProviderConfig,
  apiKey: z.string().min(1).max(4096).optional(),
});

/** 拉取模型列表响应（本地服务 → 扩展）。只含模型 ID 数组，不含 Key。 */
export const zProviderModelsResponse = z.object({
  providerType: zProviderType,
  models: z.array(z.string().min(1).max(256)),
});

/** originalText 必须是「非空白」文本：纯空白/换行不得直达 LLM 调用。 */
const zNonBlankText = z
  .string()
  .min(MIN_INPUT_LENGTH)
  .max(MAX_INPUT_LENGTH)
  .refine((v) => v.trim().length > 0, "原文不能为空");

export const zEnhancePromptRequest = z.object({
  originalText: zNonBlankText,
  taskType: zTaskTypeOrAuto.default("auto"),
  enhanceLevel: zEnhanceLevel.default("deep"),
  clarificationMode: zClarificationMode.default("smart"),
  clarificationAnswers: z.record(z.string(), z.string()).optional(),
  outputLanguage: z.string().min(1).max(64).optional(),
});

/**
 * 分析请求（POST /v1/analyze）。
 * 与增强请求同构；Prompt 只出现在请求体中，绝不出现在查询参数。
 */
export const zAnalyzeRequest = z.object({
  originalText: zNonBlankText,
  taskType: zTaskTypeOrAuto.default("auto"),
  enhanceLevel: zEnhanceLevel.default("deep"),
  clarificationMode: zClarificationMode.default("smart"),
  clarificationAnswers: z.record(z.string(), z.string()).optional(),
  outputLanguage: z.string().min(1).max(64).optional(),
});

export const zClarificationQuestion = z.object({
  id: z.string().min(1).max(64),
  question: z.string().min(1).max(200),
  reason: z.string().min(1).max(200),
  required: z.boolean().default(false),
});

export const zScoreDimensions = z.object(
  Object.fromEntries(
    SCORE_DIMENSION_KEYS.map((k) => [k, zScore]),
  ) as Record<(typeof SCORE_DIMENSION_KEYS)[number], typeof zScore>,
);

/**
 * 评分来源：llm = 模型在同一次增强调用中输出的维度分（程序只做范围限制/加权总分）；
 * heuristic_fallback = 维度缺失/非法或解析失败时降级用离线启发式。
 */
export const zScoreSource = z.enum(["llm", "heuristic_fallback"]);

export const zPromptAnalysis = z.object({
  detectedTaskType: zTaskType,
  confidence: z.number().min(0).max(1),
  scoreDimensions: zScoreDimensions,
  /** 加权总分（0–100，由程序 computeTotalScore 计算，模型不直接决定）。 */
  totalScore: zScore,
  /** 评分来源（决定展示层是否信任模型维度判断）。 */
  scoreSource: zScoreSource,
  missingInformation: z.array(z.string().max(200)),
  /** 关键缺失信息（会显著改变结果）；澄清 Gate 据此判定，程序不依赖模型的自评。 */
  criticalMissingInformation: z.array(z.string().max(200)),
  suggestions: z.array(z.string().max(500)),
  clarificationRequired: z.boolean(),
  clarificationQuestions: z
    .array(zClarificationQuestion)
    .max(MAX_CLARIFICATION_QUESTIONS),
});

export const zEnhancePromptResponse = z.object({
  enhancedText: z.string().min(1).max(MAX_INPUT_LENGTH),
  analysis: zPromptAnalysis,
  assumptions: z.array(z.string().max(300)),
  provider: z.string().min(1).max(128),
  model: z.string().min(1).max(128),
  /** 降级标记：null=完整成功；"text-fallback"/"passthrough"=管线降级路径。 */
  fallback: z.enum(["text-fallback", "passthrough"]).nullable().optional(),
});

export const zHealthResponse = z.object({
  status: z.literal("ok"),
  service: z.string(),
  version: z.string(),
  time: z.number(),
});

export const zErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const zExtensionSettings = z.object({
  // providers 默认空数组：Provider 列表由 local-agent 持久化，扩展存储仅做
  // popup 展示缓存；首次运行/旧版本迁移时该字段可能缺失，缺省不应让
  // getExtensionSettings() 抛错（否则后台全部消息处理会挂起，连接测试永久卡住）。
  providers: z.array(zProviderConfig).default([]),
  activeProviderId: z.string().optional(),
  localAgentUrl: z.string().url().default(`http://127.0.0.1:${LOCAL_AGENT_DEFAULT_PORT}`),
  localAgentToken: z.string().optional(),
  defaultEnhanceLevel: zEnhanceLevel.default("deep"),
  defaultClarificationMode: zClarificationMode.default("smart"),
  defaultTaskType: zTaskTypeOrAuto.default("auto"),
  outputLanguage: z.string().min(1).max(64).default("auto"),
});
