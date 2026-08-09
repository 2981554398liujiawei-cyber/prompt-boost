/**
 * OpenAI-Compatible Provider：调用任意 OpenAI 兼容 Chat Completions 网关。
 *
 * 特点：
 * - Base URL 必填（不提供默认值）。
 * - 自定义请求头（customHeaders）用于中转网关的鉴权头（如 Authorization、x-api-key），
 *   这些头在日志中不打印（redact 管道见 src/log.ts）。
 * - URL 安全由 resolveBaseUrl 保证：默认只允许 https，localhost/127.0.0.1 允许 http，
 *   阻止非本机私网探测。
 *
 * 阶段 4 实现 testConnection；阶段 5 实现 analyzePrompt / enhancePrompt
 * （单次 chat 调用，单块 JSON 输出）。
 */
import type { ConnectionTestResult, ProviderRequestOptions } from "@prompt-boost/shared";
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

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
}

/** OpenAI 兼容网关 /models 列表响应（仅取需要的字段）。 */
interface ModelsResponse {
  data?: Array<{ id?: string }>;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly type = "openai-compatible";
  readonly config: ProviderContext["config"];
  readonly apiKey: string;
  readonly baseUrl: string;

  constructor(ctx: ProviderContext) {
    this.config = ctx.config;
    this.apiKey = ctx.apiKey;
    // model 必填：不自动猜测模型名（可能过期或不适用于网关）。
    if (!ctx.config.model || !ctx.config.model.trim()) {
      throw new ProviderError({
        code: "INVALID_REQUEST",
        providerType: "openai-compatible",
        retryable: false,
        safeMessage: "Provider 配置缺少 model，请填写模型名称后重试",
      });
    }
    const base = ctx.baseUrl ?? ctx.config.baseUrl;
    if (!base) {
      throw new ProviderError({
        code: "INVALID_REQUEST",
        providerType: "openai-compatible",
        retryable: false,
        safeMessage: "openai-compatible 类型必须填写 Base URL",
      });
    }
    this.baseUrl = resolveBaseUrl("openai-compatible", base);
  }

  /**
   * 组装请求头：
   * - 若配置了 customHeaders 中的 Authorization / x-api-key，优先使用（网关鉴权头）。
   * - 否则回退到本地 apiKey 的 Bearer。
   */
  private headers(): Record<string, string> {
    const custom = this.config.customHeaders ?? {};
    const defaults: Record<string, string> = {};
    if (!custom.Authorization) {
      if (this.apiKey) defaults.Authorization = `Bearer ${this.apiKey}`;
    }
    return mergeHeaders(defaults, custom);
  }

  /** 连接测试：一次最小 chat 请求。 */
  async testConnection(): Promise<ConnectionTestResult> {
    const base = {
      providerId: this.config.id,
      providerType: "openai-compatible" as const,
      model: this.config.model,
      checkedAt: new Date().toISOString(),
    };
    const started = performance.now();
    const timeoutMs = this.config.timeoutSeconds * 1000;

    try {
      const data = (await postJson({
        providerType: "openai-compatible",
        url: `${this.baseUrl}/chat/completions`,
        headers: this.headers(),
        body: {
          model: this.config.model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          ...(this.config.disableThinking
            ? { thinking: { type: "disabled" } }
            : {}),
        },
        timeoutMs,
      })) as ChatCompletionResponse;

      const choices = Array.isArray(data.choices) ? data.choices : [];
      const content = choices[0]?.message?.content;

      if (!content) {
        // 推理模型（reasoning_content 有内容、content 为空）不算失败。
        const reasoning = choices[0]?.message?.reasoning_content;
        if (!reasoning) {
          return this.toFailure(
            base,
            new ProviderError({
              code: "RESPONSE_INVALID",
              providerType: "openai-compatible",
              retryable: false,
              safeMessage: "Provider 返回了空响应或缺少 choices/message/content",
            }),
            Math.round(performance.now() - started),
          );
        }
      }

      return {
        ...base,
        success: true,
        latencyMs: Math.round(performance.now() - started),
        error: null,
      };
    } catch (err) {
      if (err instanceof ProviderError) {
        return this.toFailure(base, err, Math.round(performance.now() - started));
      }
      return this.toFailure(
        base,
        mapNetworkError("openai-compatible", err),
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

  /**
   * 拉取可用模型列表：请求 /models 提取 data[].id。
   * 部分网关不实现 /models（返回 404/405）→ getJson 映射为 ProviderError，
   * 由路由层返回安全错误（前端提示后仍可手动输入）。
   */
  async listModels(): Promise<string[]> {
    const data = (await getJson({
      providerType: "openai-compatible",
      url: `${this.baseUrl}/models`,
      headers: this.headers(),
      body: {},
      timeoutMs: this.config.timeoutSeconds * 1000,
    })) as ModelsResponse;

    if (!data || typeof data !== "object") {
      throw new ProviderError({
        code: "RESPONSE_INVALID",
        providerType: "openai-compatible",
        retryable: false,
        safeMessage: "Provider 返回了无法解析的响应",
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
    options?: ProviderRequestOptions,
  ): Promise<import("./types.js").ProviderAnalyzeResult> {
    const text = await this.chat(request, options?.jsonMode ?? true, options);
    return parseProviderAnalyzeResult(text, "openai-compatible");
  }

  /** 阶段 5：单次 chat 调用，单块 JSON 输出（增强后 Prompt）。 */
  async enhancePrompt(
    request: AnalyzePromptRequest,
    options?: ProviderRequestOptions,
  ): Promise<ProviderEnhanceResult> {
    const jsonMode = options?.jsonMode ?? true;
    const text = await this.chat(request, jsonMode, options);
    // jsonMode=false：纯文本模式（textFallback 降级）。文本直接作为增强结果，
    // 不再按 JSON 解析（纯文本不含 enhancedText 字段，走 JSON 解析会误判失败）。
    if (!jsonMode) {
      return { enhancedText: text, analysis: null, assumptions: [] };
    }
    return parseProviderEnhanceResultForCompose(text, "openai-compatible");
  }

  /** 共享 chat 调用：system + user 单轮。 */
  private chat(
    request: AnalyzePromptRequest,
    jsonMode: boolean,
    options?: ProviderRequestOptions,
  ): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: request.systemPrompt ?? "" },
      { role: "user", content: request.userPrompt },
    ];
    return chatOnce(
      {
        providerType: "openai-compatible",
        timeoutMs: this.config.timeoutSeconds * 1000,
        headers: this.headers(),
        url: `${this.baseUrl}/chat/completions`,
        buildRequest: (msgs, _jsonMode) => ({
          model: this.config.model,
          messages: msgs,
          // OpenAI-Compatible 并不保证支持 response_format；结构化输出由提示词约束。
          // 仅在用户开启开关时发送 DeepSeek 扩展字段，避免影响其它网关。
          ...(this.config.disableThinking
            ? { thinking: { type: "disabled" } }
            : {}),
        }),
        extractText: (data) => extractOpenAiContent(data),
      },
      messages,
      jsonMode,
      options,
    );
  }
}

export function createOpenAiCompatibleProvider(
  ctx: ProviderContext,
): ModelProvider {
  return new OpenAiCompatibleProvider(ctx);
}
