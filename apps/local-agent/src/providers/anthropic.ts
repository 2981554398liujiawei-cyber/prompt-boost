/**
 * Anthropic Provider：调用 Anthropic Messages API。
 *
 * 阶段 4：testConnection。
 * 阶段 5：analyzePrompt / enhancePrompt —— 单次 chat 调用，单块 JSON 输出
 *         （Anthropic 无 json_object 模式，用 system 提示词约束 JSON 输出）。
 */
import type { ConnectionTestResult, ProviderRequestOptions } from "@prompt-boost/shared";
import { chatOnce, type ChatMessage } from "./chat.js";
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

const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com/v1";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MAX_TOKENS = 1;

/** Anthropic Messages API 响应（仅取需要的字段）。 */
interface MessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string | null;
}

/** Anthropic List Models API 响应（仅取需要的字段）。 */
interface ModelsResponse {
  data?: Array<{ id?: string }>;
}

/** 抽取消息内容为纯文本（支持多 content block）。 */
function textFromContent(content: MessagesResponse["content"]): string {
  if (Array.isArray(content)) {
    return content
      .filter((block) => block.type === "text" || block.text !== undefined)
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .join("");
  }
  return "";
}

export class AnthropicProvider implements ModelProvider {
  readonly type = "anthropic";
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
        providerType: "anthropic",
        retryable: false,
        safeMessage: "Provider 配置缺少 model，请填写模型名称后重试",
      });
    }
    this.baseUrl = resolveBaseUrl("anthropic", ctx.baseUrl ?? ctx.config.baseUrl ?? ANTHROPIC_DEFAULT_BASE);
  }

  private headers(): Record<string, string> {
    return mergeHeaders(
      {
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      this.config.customHeaders,
    );
  }

  /** 连接测试：一次最小 Messages 请求。 */
  async testConnection(): Promise<ConnectionTestResult> {
    const base = {
      providerId: this.config.id,
      providerType: "anthropic" as const,
      model: this.config.model,
      checkedAt: new Date().toISOString(),
    };
    const started = performance.now();
    const timeoutMs = this.config.timeoutSeconds * 1000;

    try {
      const data = (await postJson({
        providerType: "anthropic",
        url: `${this.baseUrl}/messages`,
        headers: this.headers(),
        body: {
          model: this.config.model,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          messages: [{ role: "user", content: "ping" }],
        },
        timeoutMs,
      })) as MessagesResponse;

      const text = textFromContent(data.content);
      const stopReason = data.stop_reason ?? "";

      if (!text && stopReason !== "max_tokens") {
        // 空内容且非 max_tokens 截断：视为异常响应（不抛给上层，转为失败结果）。
        return this.toFailure(
          base,
          new ProviderError({
            code: "RESPONSE_INVALID",
            providerType: "anthropic",
            retryable: false,
            safeMessage: "Anthropic 返回了空响应或异常的 stop_reason",
          }),
          Math.round(performance.now() - started),
        );
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
        mapNetworkError("anthropic", err),
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
   * 拉取可用模型列表：请求 GET {baseUrl}/models（带 x-api-key / anthropic-version 头）。
   * 响应形如 { data: [{ id }] }。失败抛 ProviderError（统一映射）。
   */
  async listModels(): Promise<string[]> {
    const data = (await getJson({
      providerType: "anthropic",
      url: `${this.baseUrl}/models`,
      headers: this.headers(),
      body: {},
      timeoutMs: this.config.timeoutSeconds * 1000,
    })) as ModelsResponse;

    if (!data || typeof data !== "object") {
      throw new ProviderError({
        code: "RESPONSE_INVALID",
        providerType: "anthropic",
        retryable: false,
        safeMessage: "Anthropic 返回了无法解析的响应",
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
    return parseProviderAnalyzeResult(text, "anthropic");
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
    return parseProviderEnhanceResultForCompose(text, "anthropic");
  }

  /**
   * 共享 chat 调用：system + user 单轮（Anthropic system 单独字段）。
   * Anthropic Messages API 不支持 json_object 模式（无 response_format 字段），
   * 输出约束由 system 提示词承担；jsonMode 仅透传给 chatOnce 用于内部语义。
   */
  private chat(
    request: AnalyzePromptRequest,
    _jsonMode: boolean,
    options?: ProviderRequestOptions,
  ): Promise<string> {
    const messages: ChatMessage[] = [{ role: "user", content: request.userPrompt }];
    return chatOnce(
      {
        providerType: "anthropic",
        timeoutMs: this.config.timeoutSeconds * 1000,
        headers: this.headers(),
        url: `${this.baseUrl}/messages`,
        // Anthropic 无 json_object 模式：绝不注入 response_format（其不识别该字段，会 400）。
        buildRequest: (msgs) => ({
          model: this.config.model,
          max_tokens: 2048,
          system: request.systemPrompt ?? "",
          messages: msgs,
        }),
        extractText: (data) => {
          const content = Array.isArray((data as { content?: unknown })?.content)
            ? (data as { content: Array<{ type?: string; text?: string }> }).content
            : [];
          return content
            .filter((b) => b.type === "text" || b.text !== undefined)
            .map((b) => (typeof b.text === "string" ? b.text : ""))
            .join("");
        },
      },
      messages,
      _jsonMode,
      options,
    );
  }
}

export function createAnthropicProvider(ctx: ProviderContext): ModelProvider {
  return new AnthropicProvider(ctx);
}
