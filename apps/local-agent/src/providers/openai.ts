/**
 * OpenAI Provider：调用 OpenAI Chat Completions API。
 *
 * 阶段 4：testConnection（真实调用 /models 或最小 chat 请求）。
 * 阶段 5：analyzePrompt / enhancePrompt —— 单次 chat 调用，单块 JSON 输出，
 *         经 prompt-engine 构建消息；结构化解析失败由引擎层降级。
 */
import type { ConnectionTestResult } from "@prompt-boost/shared";
import { chatOnce, extractOpenAiContent, type ChatMessage } from "./chat.js";
import { getJson, mergeHeaders, postJson, resolveBaseUrl } from "./http.js";
import { mapNetworkError } from "./errors.js";
import {
  ProviderError,
  parseProviderAnalyzeResult,
  parseProviderEnhanceResultForCompose,
  type AnalyzePromptRequest,
  type ModelProvider,
  type ProviderContext,
  type ProviderEnhanceResult,
} from "./types.js";

const OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

/** OpenAI 官方 /models 列表响应（仅取需要的字段）。 */
interface ModelsResponse {
  data?: Array<{ id?: string }>;
}

export class OpenAIProvider implements ModelProvider {
  readonly type = "openai";
  readonly config: ProviderContext["config"];
  readonly apiKey: string;
  readonly baseUrl: string;

  constructor(ctx: ProviderContext) {
    this.config = ctx.config;
    this.apiKey = ctx.apiKey;
    // model 必填：不允许静默选择默认模型（可能过期）。缺失时构造期即报错。
    if (!ctx.config.model || !ctx.config.model.trim()) {
      throw new ProviderError({
        code: "INVALID_REQUEST",
        providerType: "openai",
        retryable: false,
        safeMessage: "Provider 配置缺少 model，请填写模型名称后重试",
      });
    }
    this.baseUrl = resolveBaseUrl("openai", ctx.baseUrl ?? ctx.config.baseUrl ?? OPENAI_DEFAULT_BASE);
  }

  private headers(): Record<string, string> {
    return mergeHeaders(
      { Authorization: `Bearer ${this.apiKey}` },
      this.config.customHeaders,
    );
  }

  /**
   * 连接测试：请求 /models（低成本，不产生计费 token）。
   * 真正验证 Key 有效性、Base URL 可达性、响应可解析。
   * 若 /models 被网关禁用（部分兼容服务），回退到一次极小的 chat 请求。
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const base = {
      providerId: this.config.id,
      providerType: "openai" as const,
      model: this.config.model,
      checkedAt: new Date().toISOString(),
    };
    const started = performance.now();
    const timeoutMs = this.config.timeoutSeconds * 1000;

    try {
      const data = (await getJson({
        providerType: "openai",
        url: `${this.baseUrl}/models`,
        headers: this.headers(),
        body: {},
        timeoutMs,
      })) as ModelsResponse;

      // 响应必须是可解析的 JSON 对象，且尽量为数组结构（验证响应模型）。
      if (!data || typeof data !== "object") {
        throw new ProviderError({
          code: "RESPONSE_INVALID",
          providerType: "openai",
          retryable: false,
          safeMessage: "OpenAI 返回了无法解析的响应",
        });
      }

      // 模型校验：列表非空且包含配置的模型名，才算真正验证了 Model 可用性。
      // 注意：本地校验抛错不带 status（区别于网关 404），避免触发 chat 回退。
      const ids = Array.isArray(data.data)
        ? data.data.map((m) => m.id).filter((id): id is string => typeof id === "string")
        : [];
      if (ids.length === 0 || !ids.includes(this.config.model)) {
        throw new ProviderError({
          code: "MODEL_NOT_FOUND",
          providerType: "openai",
          retryable: false,
          safeMessage: `配置的模型（${this.config.model}）在当前 Provider 中不可用`,
        });
      }

      const latencyMs = Math.round(performance.now() - started);

      return {
        ...base,
        success: true,
        latencyMs,
        error: null,
      };
    } catch (err) {
      if (err instanceof ProviderError) {
        // INVALID_REQUEST / 网关侧 MODEL_NOT_FOUND（部分网关 /models 返回 404/405 且
        // 无错误详情）：视为该网关不实现 /models 接口，回退到最小 chat 请求验证；
        // 其余错误（401/429/超时/连接失败/解析失败/本地模型校验失败等）统一转为
        // 失败结果结构，不向上抛出——ConnectionTestResult 的契约就是返回
        // success:false + error。
        if (err.code === "INVALID_REQUEST") {
          return this.testConnectionViaChat(base, timeoutMs);
        }
        if (err.code === "MODEL_NOT_FOUND" && err.status === 404) {
          return this.testConnectionViaChat(base, timeoutMs);
        }
        return this.toFailure(base, err, Math.round(performance.now() - started));
      }
      return this.toFailure(
        base,
        mapNetworkError("openai", err),
        Math.round(performance.now() - started),
      );
    }
  }

  /** 构造失败结果（保持 ConnectionTestResult 的失败契约）。 */
  private toFailure(
    base: Omit<ConnectionTestResult, "success" | "latencyMs" | "error">,
    err: ProviderError,
    latencyMs: number,
  ): ConnectionTestResult {
    return {
      ...base,
      success: false,
      latencyMs,
      error: err.toSafeError(),
    };
  }

  /** 回退：用一次最小 chat 请求验证连接。 */
  private async testConnectionViaChat(
    base: Omit<ConnectionTestResult, "success" | "latencyMs" | "error">,
    timeoutMs: number,
  ): Promise<ConnectionTestResult> {
    const started = performance.now();
    await postJson({
      providerType: "openai",
      url: `${this.baseUrl}/chat/completions`,
      headers: this.headers(),
      body: {
        model: this.config.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      },
      timeoutMs,
    });
    const latencyMs = Math.round(performance.now() - started);
    return {
      ...base,
      success: true,
      latencyMs,
      error: null,
    };
  }

  /**
   * 拉取可用模型列表：请求 /models 提取 data[].id。
   * 失败抛 ProviderError（getJson 已统一映射超时/网络/HTTP 错误）。
   */
  async listModels(): Promise<string[]> {
    const data = (await getJson({
      providerType: "openai",
      url: `${this.baseUrl}/models`,
      headers: this.headers(),
      body: {},
      timeoutMs: this.config.timeoutSeconds * 1000,
    })) as ModelsResponse;

    if (!data || typeof data !== "object") {
      throw new ProviderError({
        code: "RESPONSE_INVALID",
        providerType: "openai",
        retryable: false,
        safeMessage: "OpenAI 返回了无法解析的响应",
      });
    }

    const ids = Array.isArray(data.data)
      ? data.data.map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
    return [...new Set(ids)];
  }

  /** 阶段 5：单次 chat 调用，单块 JSON 输出（分析 + 增强合一）。 */
  async analyzePrompt(
    request: AnalyzePromptRequest,
    options?: import("@prompt-boost/shared").ProviderRequestOptions,
  ): Promise<import("./types.js").ProviderAnalyzeResult> {
    const text = await this.chat(request, options?.jsonMode ?? true, options);
    return parseProviderAnalyzeResult(text, "openai");
  }

  /** 阶段 5：单次 chat 调用，单块 JSON 输出（增强后 Prompt）。 */
  async enhancePrompt(
    request: AnalyzePromptRequest,
    options?: import("@prompt-boost/shared").ProviderRequestOptions,
  ): Promise<ProviderEnhanceResult> {
    const jsonMode = options?.jsonMode ?? true;
    const text = await this.chat(request, jsonMode, options);
    // jsonMode=false：纯文本模式（textFallback 降级）。文本直接作为增强结果，
    // 不再按 JSON 解析（纯文本不含 enhancedText 字段，走 JSON 解析会误判失败）。
    if (!jsonMode) {
      return { enhancedText: text, analysis: null, assumptions: [] };
    }
    return parseProviderEnhanceResultForCompose(text, "openai");
  }

  /** 共享 chat 调用：system + user 单轮，JSON 模式用 response_format json_object。 */
  private chat(
    request: AnalyzePromptRequest,
    jsonMode: boolean,
    options?: import("@prompt-boost/shared").ProviderRequestOptions,
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: request.systemPrompt ?? "" },
      { role: "user", content: request.userPrompt },
    ];
    return chatOnce(
      {
        providerType: "openai",
        timeoutMs: this.config.timeoutSeconds * 1000,
        headers: this.headers(),
        url: `${this.baseUrl}/chat/completions`,
        buildRequest: (msgs, jm) => ({
          model: this.config.model,
          messages: msgs,
          ...(jm ? { response_format: { type: "json_object" } } : {}),
        }),
        extractText: (data) => extractOpenAiContent(data),
      },
      messages,
      jsonMode,
      options,
    );
  }
}

/** 统一入口：增强与分析的 chat 消息结构。 */
export interface EnhanceChatRequest {
  /** system 元提示（由 prompt-engine 构建）。 */
  systemPrompt: string;
  /** user 文案（原始 Prompt + 任务定义 + 追问答案，由 prompt-engine 构建）。 */
  userPrompt: string;
}

export function createOpenAIProvider(ctx: ProviderContext): ModelProvider {
  return new OpenAIProvider(ctx);
}
