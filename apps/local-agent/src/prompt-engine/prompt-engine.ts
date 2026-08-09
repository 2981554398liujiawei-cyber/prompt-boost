/**
 * Prompt Engine：Provider 编排层。
 *
 * 阶段 4：接入真实 ProviderRegistry（openai / anthropic / openai-compatible）。
 * 阶段 5：实现 /v1/enhance 管线（一次 LLM 调用完成分类+评分+追问+增强，
 *         结构化失败安全降级），并支持 /v1/analyze 离线启发式。
 */
import type { DbHandle } from "../storage/db.js";
import type { Vault } from "../security/vault.js";
import {
  createSettingsService,
  type SettingsService,
} from "../services/settings.js";
import {
  createProviderRegistry,
  type ProviderRegistry,
} from "../providers/registry.js";
import type { ModelProvider } from "../providers/types.js";
import { ProviderError } from "../providers/types.js";
import { runEnhance, type EnhanceOutcome } from "./pipeline.js";
import type { EnhancePromptRequest } from "@prompt-boost/shared";

/** Prompt Engine 对外暴露的依赖集合。 */
export interface PromptEngine {
  providers: ProviderRegistry;
  settings: SettingsService;
  /** 当前默认 Provider（无配置/未启用时返回 null）。 */
  getDefaultProvider(): Promise<ModelProvider | null>;
  /** 增强管线入口（/v1/enhance 调用）。signal 用于客户端断连时中止上游 LLM 调用。 */
  enhance(request: EnhancePromptRequest, signal?: AbortSignal): Promise<EnhanceOutcome>;
}

/** 默认 Provider 的 ProviderError 信息（供路由层映射）。 */
export function defaultProviderMissingError(): ProviderError {
  return new ProviderError({
    code: "INVALID_REQUEST",
    providerType: "engine",
    retryable: false,
    safeMessage: "尚未配置默认 Provider：请在扩展设置中添加并启用一个 Provider",
  });
}

export function createPromptEngine(db: DbHandle, vault: Vault): PromptEngine {
  const settings = createSettingsService(db, vault);
  const providers = createProviderRegistry(settings, vault);

  const getDefaultProvider = async (): Promise<ModelProvider | null> => {
    // 优先使用 activeProvider（Options 页设置默认）；没有则取第一个启用的 Provider。
    const activeId = settings.getActiveProviderId();
    if (activeId) {
      const p = await providers.get(activeId);
      if (p && p.config.enabled) return p;
    }
    for (const config of settings.listProviders()) {
      if (!config.enabled) continue;
      const p = await providers.get(config.id);
      if (p) return p;
    }
    return null;
  };

  const enhance = async (
    request: EnhancePromptRequest,
    signal?: AbortSignal,
  ): Promise<EnhanceOutcome> => {
    const provider = await getDefaultProvider();
    if (!provider) {
      throw defaultProviderMissingError();
    }
    return runEnhance(request, {
      provider,
      providerLabel: `${provider.type}/${provider.config.model}`,
      signal,
    });
  };

  return {
    providers,
    settings,
    getDefaultProvider,
    enhance,
  };
}
