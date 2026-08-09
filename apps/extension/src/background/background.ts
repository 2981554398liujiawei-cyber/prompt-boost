/**
 * Background Service Worker。
 * 职责：content ↔ local-agent 消息转发；设置读取；错误标准化。
 */
import {
  MessageType,
  zEnhancePromptResponse,
  type BoostAnalyzeMessage,
  type BoostAnalyzeReply,
  type BoostEnhanceMessage,
  type BoostEnhanceReply,
} from "@prompt-boost/shared";
import { requestLocalAgent, clientOptionsFrom, ENHANCE_TIMEOUT_MS } from "./localAgentClient.js";
import { respond } from "./respond.js";
import {
  getExtensionSettings,
  getLocalAgentToken,
} from "./settings.js";
import {
  createProviderToAgent,
  deleteProviderFromAgent,
  listModelsFromAgent,
  listProvidersFromAgent,
  saveProviderToAgent,
  setDefaultProviderToAgent,
  testProviderConnection,
} from "./providerClient.js";

async function handleBoostEnhance(message: BoostEnhanceMessage): Promise<BoostEnhanceReply> {
  const settings = await getExtensionSettings();
  const token = await getLocalAgentToken();
  // /v1/enhance 走真实 LLM 生成（实测 ~20s，可能更久），不能套用 15s 默认超时。
  // 用 90s 整体上限：慢但正常的生成能完成。扩展侧中止后客户端断开，
  // local-agent 的 /v1/enhance 通过 req close 信号中止上游 LLM 调用，避免
  // 每次超时都白烧一次上游调用。
  const requestAbortSignal = AbortSignal.timeout(ENHANCE_TIMEOUT_MS);
  const result = await requestLocalAgent(clientOptionsFrom(settings, token), {
    path: "/v1/enhance",
    method: "POST",
    token,
    timeoutMs: ENHANCE_TIMEOUT_MS,
    requestAbortSignal,
    body: {
      originalText: message.originalText,
      taskType: message.settings.taskType,
      enhanceLevel: message.settings.enhanceLevel,
      clarificationMode: message.settings.clarificationMode,
      outputLanguage: message.settings.outputLanguage,
      clarificationAnswers: message.settings.clarificationAnswers ?? {},
    },
  });

  if (!result.ok) {
    return { requestId: message.requestId, error: result };
  }

  // /v1/enhance 在 Provider 层错误时返回 HTTP 200 + 体内 error（passthrough 原文），
  // 扩展必须把它识别为失败并展示安全消息，而不是把原文当增强结果写回。
  const body = result.data as { error?: { code?: string; message?: string }; enhancedText?: unknown };
  if (body.error) {
    return {
      requestId: message.requestId,
      error: {
        ok: false,
        code: body.error.code ?? "local-agent",
        message: body.error.message ?? "增强失败",
      },
    };
  }

  // 统一校验返回值。
  const parsed = zEnhancePromptResponse.safeParse(result.data);
  if (!parsed.success) {
    return {
      requestId: message.requestId,
      error: {
        ok: false,
        code: "validation",
        message: "本地服务返回的增强结果格式不正确",
      },
    };
  }
  return { requestId: message.requestId, response: parsed.data };
}

async function handleBoostAnalyze(message: BoostAnalyzeMessage): Promise<BoostAnalyzeReply> {
  const settings = await getExtensionSettings();
  const token = await getLocalAgentToken();
  const result = await requestLocalAgent(clientOptionsFrom(settings, token), {
    path: "/v1/analyze",
    method: "POST",
    token,
    body: {
      originalText: message.text,
      taskType: message.taskType ?? "auto",
      enhanceLevel: message.enhanceLevel ?? "deep",
      clarificationMode: message.clarificationMode ?? "smart",
    },
    timeoutMs: 10_000,
  });
  if (!result.ok) {
    return { requestId: message.requestId, error: result };
  }
  const data = result.data as {
    detectedTaskType?: string;
    confidence?: number;
    scoreDimensions?: Record<string, number>;
    totalScore?: number;
    scoreSource?: string;
    missingInformation?: string[];
    suggestions?: string[];
  };
  return {
    requestId: message.requestId,
    result: {
      detectedTaskType: data.detectedTaskType ?? "general",
      confidence: data.confidence ?? 0,
      scoreDimensions: data.scoreDimensions ?? {},
      totalScore: data.totalScore ?? 0,
      scoreSource: data.scoreSource ?? "heuristic_fallback",
      missingInformation: data.missingInformation ?? [],
      suggestions: data.suggestions ?? [],
    },
  };
}

interface PingReply {
  ok: true;
  data: unknown;
}

async function handlePing(): Promise<PingReply | undefined> {
  const settings = await getExtensionSettings();
  const token = await getLocalAgentToken();
  const result = await requestLocalAgent(clientOptionsFrom(settings, token), {
    path: "/health",
    method: "GET",
    token,
  });
  if (!result.ok) return undefined;
  return { ok: true, data: result.data };
}

// ── Provider 管理（Options → background → local-agent）────────────
// 完整 API Key 只在 Options 输入，经 background 转发到 local-agent Vault；
// background / chrome.storage / content 均不保存完整 Key。

interface ProviderSaveMessage {
  type: "provider/save";
  config: import("@prompt-boost/shared").ProviderConfig;
  apiKey?: string;
  isNew?: boolean;
}
interface ProviderDeleteMessage {
  type: "provider/delete";
  id: string;
}
interface ProviderTestMessage {
  type: "provider/test";
  config: import("@prompt-boost/shared").ProviderConfig;
  apiKey?: string;
}
interface ProviderModelsMessage {
  type: "provider/models";
  config: import("@prompt-boost/shared").ProviderConfig;
  apiKey?: string;
}
interface ProviderSetDefaultMessage {
  type: "provider/set-default";
  id: string;
}

async function handleProviderList(): Promise<{ providers: import("@prompt-boost/shared").ProviderSummary[]; activeProviderId: string | null }> {
  const result = await listProvidersFromAgent();
  return { providers: result.providers, activeProviderId: result.activeProviderId };
}

async function handleProviderSave(msg: ProviderSaveMessage): Promise<{ provider: import("@prompt-boost/shared").ProviderSummary }> {
  const provider = msg.isNew
    ? await createProviderToAgent(msg.config, msg.apiKey)
    : await saveProviderToAgent(msg.config, msg.apiKey);
  return { provider };
}

async function handleProviderDelete(msg: ProviderDeleteMessage): Promise<{ ok: true }> {
  await deleteProviderFromAgent(msg.id);
  return { ok: true };
}

async function handleProviderTest(
  msg: ProviderTestMessage,
): Promise<import("@prompt-boost/shared").ConnectionTestResult> {
  return testProviderConnection(msg.config, msg.apiKey);
}

async function handleProviderModels(
  msg: ProviderModelsMessage,
): Promise<import("@prompt-boost/shared").ProviderModelsResult> {
  return listModelsFromAgent(msg.config, msg.apiKey);
}

async function handleProviderSetDefault(msg: ProviderSetDefaultMessage): Promise<{ ok: true }> {
  await setDefaultProviderToAgent(msg.id);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const msg = message as { type?: string };

  if (msg?.type === MessageType.BoostEnhance) {
    respond(() => handleBoostEnhance(msg as BoostEnhanceMessage), sendResponse);
    return true;
  }
  if (msg?.type === MessageType.BoostAnalyze) {
    respond(() => handleBoostAnalyze(msg as BoostAnalyzeMessage), sendResponse);
    return true;
  }
  if (msg?.type === MessageType.PingLocalAgent) {
    respond(() => handlePing(), sendResponse);
    return true;
  }
  if (msg?.type === "provider/list") {
    respond(handleProviderList, sendResponse);
    return true;
  }
  if (msg?.type === "provider/save") {
    respond(() => handleProviderSave(msg as ProviderSaveMessage), sendResponse);
    return true;
  }
  if (msg?.type === "provider/delete") {
    respond(() => handleProviderDelete(msg as ProviderDeleteMessage), sendResponse);
    return true;
  }
  if (msg?.type === "provider/test") {
    respond(() => handleProviderTest(msg as ProviderTestMessage), sendResponse);
    return true;
  }
  if (msg?.type === "provider/models") {
    respond(() => handleProviderModels(msg as ProviderModelsMessage), sendResponse);
    return true;
  }
  if (msg?.type === "provider/set-default") {
    respond(() => handleProviderSetDefault(msg as ProviderSetDefaultMessage), sendResponse);
    return true;
  }
  return false;
});
