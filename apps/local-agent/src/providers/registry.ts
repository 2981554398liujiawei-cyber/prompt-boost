/**
 * Provider 注册表：按类型创建并缓存 Provider 实例。
 *
 * 设计：
 * - 路由/引擎层不直接 switch 创建 Provider，统一走 registry.get()。
 * - 未知 Provider 类型直接抛错，不允许静默降级。
 * - 缓存键 = 配置指纹 + apiKey 哈希；配置/密钥变化后旧实例失效并重建。
 * - testConnection 同时接收未保存的配置（测试连接不应要求先入库）。
 */
import { createHash } from "node:crypto";
import type { ProviderConfig } from "@prompt-boost/shared";
import type { SettingsService } from "../services/settings.js";
import type { Vault } from "../security/vault.js";
import { createAnthropicProvider } from "./anthropic.js";
import { createOpenAiCompatibleProvider } from "./openai-compatible.js";
import { createOpenAIProvider } from "./openai.js";
import { ProviderError, type ModelProvider, type ProviderContext } from "./types.js";

/** 计算配置指纹（不含时间戳，仅配置实质内容）。 */
function fingerprint(config: ProviderConfig, apiKey: string | null): string {
  const payload = JSON.stringify({
    type: config.type,
    baseUrl: config.baseUrl ?? "",
    model: config.model,
    timeoutSeconds: config.timeoutSeconds,
    customHeaders: config.customHeaders ?? {},
    disableThinking: config.disableThinking ?? false,
    enabled: config.enabled,
    apiKey: apiKey ?? "",
  });
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export interface ProviderRegistry {
  /** 获取（并缓存）已保存的 Provider 实例。不存在返回 null。 */
  get(id: string): Promise<ModelProvider | null>;
  /** 获取实例，缺失时抛 ProviderError（NOT_FOUND）。 */
  getOrThrow(id: string): Promise<ModelProvider>;
  /** 测试连接：用给定配置 + apiKey（未保存的配置也可测试）。 */
  test(config: ProviderConfig, apiKey?: string): Promise<ModelProvider>;
  /** 使某 Provider 缓存失效（配置/密钥变更或删除后调用）。 */
  invalidate(id: string): void;
  /** 列出所有已保存 Provider 实例（跳过禁用项）。 */
  list(): Promise<ModelProvider[]>;
}

export function createProviderRegistry(
  settings: SettingsService,
  _vault: Vault,
): ProviderRegistry {
  /** 缓存：id → { instance, fingerprint }。 */
  const cache = new Map<string, { instance: ModelProvider; fingerprint: string }>();

  const makeProvider = (config: ProviderConfig, apiKey: string): ModelProvider => {
    const ctx: ProviderContext = { config, apiKey, baseUrl: config.baseUrl };
    switch (config.type) {
      case "openai":
        return createOpenAIProvider(ctx);
      case "anthropic":
        return createAnthropicProvider(ctx);
      case "openai-compatible":
        return createOpenAiCompatibleProvider(ctx);
      default: {
        // 未知类型：显式报错，不静默降级。
        const unknown: never = config.type;
        void unknown;
        throw new ProviderError({
          code: "INVALID_REQUEST",
          providerType: "unknown",
          retryable: false,
          safeMessage: `不支持的 Provider 类型：${String(config.type)}`,
        });
      }
    }
  };

  return {
    async get(id) {
      const cached = cache.get(id);
      const stored = await settings.getProviderWithKey(id);
      if (!stored) {
        cache.delete(id);
        return null;
      }
      const { config, apiKey } = stored;
      const fp = fingerprint(config, apiKey);
      if (cached && cached.fingerprint === fp) return cached.instance;
      // 配置或密钥变化：重建并更新缓存。
      const instance = makeProvider(config, apiKey ?? "");
      cache.set(id, { instance, fingerprint: fp });
      return instance;
    },

    async getOrThrow(id) {
      const provider = await this.get(id);
      if (!provider) {
        throw new ProviderError({
          code: "MODEL_NOT_FOUND",
          providerType: "registry",
          retryable: false,
          safeMessage: `Provider 不存在：${id}`,
        });
      }
      return provider;
    },

    async test(config, apiKey) {
      return makeProvider(config, apiKey ?? "");
    },

    invalidate(id) {
      cache.delete(id);
    },

    async list() {
      const configs = settings.listProviders();
      const providers: ModelProvider[] = [];
      for (const config of configs) {
        if (!config.enabled) continue;
        const provider = await this.get(config.id);
        if (provider) providers.push(provider);
      }
      return providers;
    },
  };
}
