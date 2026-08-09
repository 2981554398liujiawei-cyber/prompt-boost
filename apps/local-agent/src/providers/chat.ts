/**
 * Provider 层通用 chat 调用辅助。
 *
 * 阶段 5：三个 Provider（openai / anthropic / openai-compatible）都通过
 * 本模块发起「单次 LLM 调用」并解析「单块输出」。差异封装在请求构造器里：
 * - OpenAI / openai-compatible：POST {base}/chat/completions，message.content 单块。
 * - Anthropic：POST {base}/messages，content 为 text block 数组。
 *
 * 安全：
 * - 请求体只含 messages 等业务字段，绝不把 API Key 放进 body（Key 只出现在
 *   Authorization / x-api-key 请求头，且已被 http.ts 统一脱敏）。
 * - 超时用 Provider 的 timeoutSeconds（与连接测试一致），经 http.ts 映射为 TIMEOUT。
 * - 输出解析只接受「单个文本块」，多块/空响应 → RESPONSE_INVALID，交上层降级。
 */
import type { ProviderRequestOptions } from "@prompt-boost/shared";
import { postJson } from "./http.js";
import { ProviderError } from "./types.js";
/** 一次 LLM 会话：system + user（+ 可选的追问答案已并入 user 文案）。 */
export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** chat 请求构造器（各 Provider 差异）。 */
export interface ChatRequestBuilder {
  providerType: string;
  /** 生成请求体的方法（各 Provider 差异；model 由闭包捕获，不重复传入）。 */
  buildRequest: (messages: ChatMessage[], jsonMode: boolean) => Record<string, unknown>;
  /** 从响应体中提取纯文本（各 Provider 响应结构差异）。 */
  extractText: (data: unknown) => string;
  timeoutMs: number;
  headers: Record<string, string>;
  url: string;
}

/** 统一 chat 调用入口：单次请求 + 单块文本解析。 */
export async function chatOnce(
  builder: ChatRequestBuilder,
  messages: ChatMessage[],
  jsonMode: boolean,
  options?: ProviderRequestOptions,
): Promise<string> {
  const body = builder.buildRequest(messages, jsonMode);
  const data = await postJson({
    providerType: builder.providerType,
    url: builder.url,
    headers: builder.headers,
    body,
    timeoutMs: builder.timeoutMs,
    signal: options?.signal,
  });
  const text = builder.extractText(data);
  if (!text.trim()) {
    throw new ProviderError({
      code: "RESPONSE_INVALID",
      providerType: builder.providerType,
      retryable: false,
      safeMessage: "Provider 返回了空响应（无文本内容）",
    });
  }
  return text;
}

/** 尝试把纯文本解析为单块 JSON（容忍围栏/前后空白）。返回 null 表示非 JSON。 */
export function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  // 去掉可能的 ```json … ``` 围栏。
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidate = fence ? fence[1] : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const json = candidate.slice(start, end + 1);
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 从 OpenAI 系 Chat Completions 响应中提取纯文本。
 * 优先读取 content；若为空（推理模型把输出放 reasoning_content、content 恒空），
 * 回退读取 reasoning_content，避免把合法响应误判为空（RESPONSE_INVALID）。
 */
export function extractOpenAiContent(data: unknown): string {
  const choices = Array.isArray((data as { choices?: unknown })?.choices)
    ? (data as { choices: Array<{ message?: { content?: string; reasoning_content?: string } }> }).choices
    : [];
  const msg = choices[0]?.message;
  const content = msg?.content?.trim();
  if (content) return content;
  return msg?.reasoning_content ?? "";
}
