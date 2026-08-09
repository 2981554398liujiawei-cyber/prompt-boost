export const TASK_TYPES = [
  "writing",
  "coding",
  "business",
  "analysis",
  "research",
  "learning",
  "translation",
  "planning",
  "creative",
  "general",
] as const;

export type TaskType = (typeof TASK_TYPES)[number];

export const ENHANCE_LEVELS = ["quick", "deep", "expert"] as const;
export type EnhanceLevel = (typeof ENHANCE_LEVELS)[number];

export const CLARIFICATION_MODES = ["off", "smart", "always"] as const;
export type ClarificationMode = (typeof CLARIFICATION_MODES)[number];

export const PROVIDER_TYPES = ["openai", "anthropic", "openai-compatible"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const BOOST_STATES = [
  "idle",
  "reading",
  "analyzing",
  "clarifying",
  "enhancing",
  "writing",
  "success",
  "conflict",
  "error",
] as const;
export type BoostState = (typeof BOOST_STATES)[number];

import type { Settings } from "./types.js";

/**
 * 默认设置。遵循产品定义：
 * - enhanceLevel 默认 deep
 * - clarificationMode 默认 smart
 * - taskType 默认 auto
 */
export const DEFAULT_SETTINGS = {
  enhanceLevel: "deep",
  clarificationMode: "smart",
  taskType: "auto",
  outputLanguage: "auto",
} as const satisfies Readonly<Settings>;

/** 本地服务默认监听地址。 */
export const LOCAL_AGENT_DEFAULT_HOST = "127.0.0.1";
export const LOCAL_AGENT_DEFAULT_PORT = 8787;
export const LOCAL_AGENT_DEFAULT_URL = `http://${LOCAL_AGENT_DEFAULT_HOST}:${LOCAL_AGENT_DEFAULT_PORT}`;

/** 认证令牌最小长度（本地服务启动时校验）。 */
export const AUTH_TOKEN_MIN_LENGTH = 16;

/** 输入框文本允许的最大长度。 */
export const MAX_INPUT_LENGTH = 20_000;

/** 输入框文本的最小长度（低于此值视为无效输入）。 */
export const MIN_INPUT_LENGTH = 1;

/** 一次追问最多问题数。 */
export const MAX_CLARIFICATION_QUESTIONS = 3;

/** 评分维度权重（总和 100）。 */
export const SCORE_WEIGHTS = {
  objective: 20,
  context: 15,
  audience: 10,
  outputFormat: 15,
  constraints: 10,
  role: 10,
  materials: 10,
  actionability: 10,
} as const satisfies Record<ScoreDimensionKey, number>;

export const SCORE_DIMENSION_KEYS = [
  "objective",
  "context",
  "audience",
  "outputFormat",
  "constraints",
  "role",
  "materials",
  "actionability",
] as const;
export type ScoreDimensionKey = (typeof SCORE_DIMENSION_KEYS)[number];

/** 扩展版本号（与 manifest 保持一致，避免引用 JSON 造成构建耦合）。 */
export const EXTENSION_VERSION = "0.1.0";
