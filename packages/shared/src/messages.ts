import type { EnhancePromptResponse } from "./types.js";

/** 扩展内部消息类型。 */
export const MessageType = {
  /** content → background：请求增强（走本地服务）。 */
  BoostEnhance: "boost/enhance",
  /** content → background：请求评分/分析（本地服务 /v1/analyze）。 */
  BoostAnalyze: "boost/analyze",
  /** content → background：请求本地服务健康检查。 */
  PingLocalAgent: "local-agent/ping",
  /** background → content：状态广播。 */
  StateChanged: "state/changed",
  /** popup/options → background：读取扩展设置。 */
  GetSettings: "settings/get",
  /** popup/options → background：保存扩展设置。 */
  SaveSettings: "settings/save",
  /** options → background：触发连接测试。 */
  TestProvider: "provider/test",
  /** background → content：初始化完成（可选）。 */
  Init: "init",
} as const;
export type MessageTypeValue = (typeof MessageType)[keyof typeof MessageType];

/** 统一的本地服务请求体（background → local-agent）。 */
export interface LocalAgentRequest<TBody> {
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  token: string;
  body?: TBody;
  query?: Record<string, string>;
  /** 请求级超时（毫秒）。缺省用客户端默认值。 */
  timeoutMs?: number;
  /**
   * 调用方中止信号（如 background 的 90s 整体上限）。
   * 仅内部请求链使用，不会跨 postMessage 序列化到其他上下文。
   * 用 AbortSignalLike 保持 shared 无 DOM 依赖（与 ProviderRequestOptions 一致）。
   */
  requestAbortSignal?: import("./types.js").AbortSignalLike;
}

/** 统一的本地服务响应体（background → content）。 */
export interface LocalAgentResult<TData> {
  ok: true;
  data: TData;
}

/** 标准化的本地服务失败结果。 */
export interface LocalAgentFailure {
  ok: false;
  /** 稳定错误码：network / http / local-agent / validation / unknown。 */
  code: string;
  message: string;
  httpStatus?: number;
}

export type LocalAgentResponse<TData> = LocalAgentResult<TData> | LocalAgentFailure;

/** Boost 增强消息（content → background）。 */
export interface BoostEnhanceMessage {
  requestId: string;
  originalText: string;
  settings: {
    taskType: string;
    enhanceLevel: string;
    clarificationMode: string;
    outputLanguage: string;
    clarificationAnswers?: Record<string, string>;
  };
}

/** Boost 评分/分析消息（content → background）。请求体与 POST /v1/analyze 一致。 */
export interface BoostAnalyzeMessage {
  requestId: string;
  text: string;
  taskType?: string;
  enhanceLevel?: string;
  clarificationMode?: string;
}

/** Boost 评分/分析响应（background → content）。 */
export interface BoostAnalyzeReply {
  requestId: string;
  /** 评分结果（本地服务 /v1/analyze 结构）。 */
  result?: {
    detectedTaskType: string;
    confidence: number;
    scoreDimensions: Record<string, number>;
    totalScore: number;
    scoreSource: string;
    missingInformation: string[];
    suggestions: string[];
  };
  error?: LocalAgentFailure;
}

/** Boost 增强响应消息（background → content）。 */
export interface BoostEnhanceReply {
  requestId: string;
  response?: EnhancePromptResponse;
  error?: LocalAgentFailure;
}

/** 统一的本地服务错误码。 */
export const LocalAgentErrorCode = {
  Network: "network",
  Timeout: "timeout",
  Http: "http",
  Validation: "validation",
  LocalAgent: "local-agent",
  Unknown: "unknown",
} as const;
export type LocalAgentErrorCodeValue =
  (typeof LocalAgentErrorCode)[keyof typeof LocalAgentErrorCode];
