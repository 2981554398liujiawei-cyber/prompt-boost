/**
 * 设置存储：非敏感设置以 JSON 存 SQLite；API Key 走 Vault。
 */
import {
  zSettings,
  zSettingsUpdate,
  type ProviderConfig,
  type ProviderSummary,
  type Settings,
} from "@prompt-boost/shared";
import type { DbHandle } from "../storage/db.js";
import type { Vault } from "../security/vault.js";

const SETTINGS_KEY = "settings";
const ACTIVE_PROVIDER_KEY = "activeProvider";
const PROVIDER_KEY_PREFIX = "providerKey:";
const PROVIDER_HEADERS_PREFIX = "providerHeaders:";
const MASKED_SECRET = "***";
/** 同一 DbHandle 的多个 SettingsService（App/PromptEngine）共享 Provider 写锁。 */
const PROVIDER_LOCKS = new WeakMap<DbHandle, Map<string, Promise<unknown>>>();

/**
 * 敏感请求头名（大小写不敏感）：值在 API 回显中必须脱敏。
 * 存储仍明文（SQLite 是本机文件，风险主要是 API 回显/日志），
 * 但响应体绝不携带这些头的完整值（与 apiKeyConfigured 同模式）。
 */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "x-key",
  "api-key",
  "apikey",
  "token",
]);

/** 保守识别鉴权类 Header；这类值只允许进入 Vault。 */
export function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    SENSITIVE_HEADERS.has(normalized) ||
    /(?:^|[-_])(auth|key|secret|token)(?:$|[-_])/.test(normalized)
  );
}

/** 敏感头值脱敏：只保留「已配置」标记，绝不回显完整值。 */
export function redactCustomHeaders(
  customHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!customHeaders) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(customHeaders)) {
    out[k] = isSensitiveHeaderName(k) ? MASKED_SECRET : v;
  }
  return out;
}

export interface SettingsService {
  getSettings(): Settings;
  updateSettings(partial: Partial<Settings>): Settings;
  listProviders(): ProviderConfig[];
  migrateAllProviderHeaders(): Promise<void>;
  listProviderSummaries(): Promise<ProviderSummary[]>;
  getProviderSummary(id: string): Promise<ProviderSummary | null>;
  getProvider(id: string): ProviderConfig | null;
  getProviderWithKey(id: string): Promise<{ config: ProviderConfig; apiKey: string | null } | null>;
  resolveProviderInput(
    config: ProviderConfig,
    apiKey?: string,
  ): Promise<{ config: ProviderConfig; apiKey: string }>;
  saveProvider(config: ProviderConfig, apiKey?: string): Promise<void>;
  deleteProvider(id: string): Promise<void>;
  getActiveProviderId(): string | null;
  setActiveProviderId(id: string): void;
}

export function createSettingsService(db: DbHandle, vault: Vault): SettingsService {
  const headerSecretKey = (id: string): string => `${PROVIDER_HEADERS_PREFIX}${id}`;
  let providerLocks = PROVIDER_LOCKS.get(db);
  if (!providerLocks) {
    providerLocks = new Map<string, Promise<unknown>>();
    PROVIDER_LOCKS.set(db, providerLocks);
  }

  const withProviderLock = async <T>(id: string, action: () => Promise<T>): Promise<T> => {
    const previous = providerLocks.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    providerLocks.set(id, run);
    try {
      return await run;
    } finally {
      if (providerLocks.get(id) === run) providerLocks.delete(id);
    }
  };

  const readSecretHeaders = async (id: string): Promise<Record<string, string>> => {
    const raw = await vault.getSecret(headerSecretKey(id));
    if (!raw) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("敏感请求头 Vault 数据格式无效");
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string" && value.length > 0) headers[name] = value;
      }
      return headers;
    } catch (err) {
      throw new Error("敏感请求头 Vault 数据损坏", { cause: err });
    }
  };

  const findHeaderValue = (
    headers: Record<string, string>,
    name: string,
  ): string | undefined => {
    const wanted = name.toLowerCase();
    const match = Object.entries(headers).find(([key]) => key.toLowerCase() === wanted);
    return match?.[1];
  };

  const restoreSecret = async (key: string, previous: string | null): Promise<void> => {
    if (previous === null) await vault.deleteSecret(key);
    else await vault.setSecret(key, previous);
  };

  const rollbackOrRethrow = async (
    original: unknown,
    actions: Array<() => Promise<void>>,
  ): Promise<never> => {
    const results = await Promise.allSettled(actions.map((action) => action()));
    const rollbackErrors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (rollbackErrors.length > 0) {
      throw new AggregateError([original, ...rollbackErrors], "Provider 更新失败且回滚不完整");
    }
    throw original;
  };

  /**
   * 读取运行时配置，并把旧版本 SQLite 中的敏感 Header 明文一次性迁移进 Vault。
   * 迁移先写 Vault、再擦除数据库；数据库失败时恢复原 Vault 值。
   */
  const hydrateConfigUnlocked = async (config: ProviderConfig): Promise<ProviderConfig> => {
    const previousSecret = await vault.getSecret(headerSecretKey(config.id));
    const secrets = await readSecretHeaders(config.id);
    const runtimeHeaders: Record<string, string> = {};
    const storedHeaders: Record<string, string> = {};
    let needsMigration = false;

    for (const [name, value] of Object.entries(config.customHeaders ?? {})) {
      if (!isSensitiveHeaderName(name)) {
        runtimeHeaders[name] = value;
        storedHeaders[name] = value;
        continue;
      }
      const actual = value === MASKED_SECRET ? findHeaderValue(secrets, name) : value;
      if (actual) {
        runtimeHeaders[name] = actual;
        secrets[name] = actual;
      }
      storedHeaders[name] = MASKED_SECRET;
      if (value !== MASKED_SECRET) needsMigration = true;
    }

    if (needsMigration) {
      try {
        await vault.setSecret(headerSecretKey(config.id), JSON.stringify(secrets));
        db.upsertProvider({ ...config, customHeaders: storedHeaders });
        db.purgeSensitiveResidue?.();
      } catch (err) {
        return await rollbackOrRethrow(err, [
          () => restoreSecret(headerSecretKey(config.id), previousSecret),
        ]);
      }
    }

    return {
      ...config,
      customHeaders: Object.keys(runtimeHeaders).length > 0 ? runtimeHeaders : undefined,
    };
  };

  const hydrateConfig = (config: ProviderConfig): Promise<ProviderConfig> =>
    withProviderLock(config.id, () => hydrateConfigUnlocked(config));
  const getSettings = (): Settings => {
    const raw = db.getSetting(SETTINGS_KEY);
    if (!raw) return zSettings.parse({});
    try {
      return zSettings.parse(JSON.parse(raw));
    } catch {
      return zSettings.parse({});
    }
  };

  const updateSettings = (partial: Partial<Settings>): Settings => {
    // 严格校验：非法枚举 / 未知字段直接抛 ZodError（由路由层转为 400）。
    zSettingsUpdate.parse(partial);
    const merged = { ...getSettings(), ...partial };
    const parsed = zSettings.parse(merged);
    db.setSetting(SETTINGS_KEY, JSON.stringify(parsed));
    return parsed;
  };

  const listProviders = (): ProviderConfig[] => db.listProviders().map(toConfig);

  const migrateAllProviderHeaders = async (): Promise<void> => {
    // 不看 enabled：禁用 Provider 同样不能把旧敏感值留在 SQLite。
    for (const config of listProviders()) await hydrateConfig(config);
  };

  const listProviderSummaries = async (): Promise<ProviderSummary[]> => {
    const configs = listProviders();
    const summaries: ProviderSummary[] = [];
    for (const storedConfig of configs) {
      const config = await hydrateConfig(storedConfig);
      const hasKey = await vault.hasSecret(`${PROVIDER_KEY_PREFIX}${config.id}`);
      // 响应脱敏：敏感请求头值（Authorization/x-api-key 等）不回显完整值。
      summaries.push({
        ...config,
        customHeaders: redactCustomHeaders(config.customHeaders),
        apiKeyConfigured: hasKey,
      });
    }
    return summaries;
  };

  const getProviderSummary = async (id: string): Promise<ProviderSummary | null> => {
    const config = getProvider(id);
    if (!config) return null;
    const hydrated = await hydrateConfig(config);
    return {
      ...hydrated,
      customHeaders: redactCustomHeaders(hydrated.customHeaders),
      apiKeyConfigured: await vault.hasSecret(`${PROVIDER_KEY_PREFIX}${id}`),
    };
  };

  const getProvider = (id: string): ProviderConfig | null => {
    const row = db.getProvider(id);
    return row ? toConfig(row) : null;
  };

  const getProviderWithKey = async (id: string) => {
    return withProviderLock(id, async () => {
      const config = getProvider(id);
      if (!config) return null;
      const apiKey = await vault.getSecret(`${PROVIDER_KEY_PREFIX}${id}`);
      return { config: await hydrateConfigUnlocked(config), apiKey };
    });
  };

  const resolveProviderInput = async (config: ProviderConfig, apiKey?: string) => {
    const existing = await getProviderWithKey(config.id);
    const resolvedHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.customHeaders ?? {})) {
      if (value === MASKED_SECRET && isSensitiveHeaderName(name)) {
        const previous = findHeaderValue(existing?.config.customHeaders ?? {}, name);
        if (previous) resolvedHeaders[name] = previous;
      } else {
        resolvedHeaders[name] = value;
      }
    }
    return {
      config: {
        ...config,
        customHeaders: Object.keys(resolvedHeaders).length > 0 ? resolvedHeaders : undefined,
      },
      apiKey: apiKey ?? existing?.apiKey ?? "",
    };
  };

  const saveProvider = (config: ProviderConfig, apiKey?: string): Promise<void> =>
    withProviderLock(config.id, async () => {
    const existing = getProvider(config.id);
    const existingRuntime = existing ? await hydrateConfigUnlocked(existing) : null;
    const now = new Date().toISOString();
    const storedHeaders: Record<string, string> = {};
    const secretHeaders: Record<string, string> = {};
    for (const [name, value] of Object.entries(config.customHeaders ?? {})) {
      if (!isSensitiveHeaderName(name)) {
        storedHeaders[name] = value;
        continue;
      }
      const actual =
        value === MASKED_SECRET
          ? findHeaderValue(existingRuntime?.customHeaders ?? {}, name)
          : value;
      if (actual) {
        secretHeaders[name] = actual;
        storedHeaders[name] = MASKED_SECRET;
      }
    }
    const merged: ProviderConfig = {
      ...config,
      customHeaders: Object.keys(storedHeaders).length > 0 ? storedHeaders : undefined,
      createdAt: existing?.createdAt ?? config.createdAt ?? now,
      updatedAt: now,
    };
    const headersKey = headerSecretKey(config.id);
    const apiKeyName = `${PROVIDER_KEY_PREFIX}${config.id}`;
    const previousHeaders = await vault.getSecret(headersKey);
    const previousApiKey = await vault.getSecret(apiKeyName);
    try {
      if (Object.keys(secretHeaders).length > 0) {
        await vault.setSecret(headersKey, JSON.stringify(secretHeaders));
      } else {
        await vault.deleteSecret(headersKey);
      }
      if (apiKey) await vault.setSecret(apiKeyName, apiKey);
      db.upsertProvider(merged);
    } catch (err) {
      return await rollbackOrRethrow(err, [
        () => restoreSecret(headersKey, previousHeaders),
        () => restoreSecret(apiKeyName, previousApiKey),
      ]);
    }
  });

  const deleteProvider = (id: string): Promise<void> => withProviderLock(id, async () => {
    const config = getProvider(id);
    const apiKeyName = `${PROVIDER_KEY_PREFIX}${id}`;
    const headersKey = headerSecretKey(id);
    const previousApiKey = await vault.getSecret(apiKeyName);
    const previousHeaders = await vault.getSecret(headersKey);
    try {
      await vault.deleteSecret(apiKeyName);
      await vault.deleteSecret(headersKey);
      db.deleteProvider(id);
    } catch (err) {
      return await rollbackOrRethrow(err, [
        () => restoreSecret(apiKeyName, previousApiKey),
        () => restoreSecret(headersKey, previousHeaders),
        async () => {
          if (config && !getProvider(id)) db.upsertProvider(config);
        },
      ]);
    }
  });

  const getActiveProviderId = (): string | null => db.getSetting(ACTIVE_PROVIDER_KEY);

  const setActiveProviderId = (id: string): void => {
    db.setSetting(ACTIVE_PROVIDER_KEY, id);
  };

  return {
    getSettings,
    updateSettings,
    listProviders,
    migrateAllProviderHeaders,
    listProviderSummaries,
    getProviderSummary,
    getProvider,
    getProviderWithKey,
    resolveProviderInput,
    saveProvider,
    deleteProvider,
    getActiveProviderId,
    setActiveProviderId,
  };
}

function toConfig(row: {
  id: string;
  type: string;
  name: string;
  base_url: string;
  model: string;
  timeout_seconds: number;
  custom_headers_json: string | null;
  disable_thinking: number;
  enabled: number;
  created_at: string | null;
  updated_at: string | null;
}): ProviderConfig {
  return {
    id: row.id,
    type: row.type as ProviderConfig["type"],
    name: row.name,
    baseUrl: row.base_url,
    model: row.model,
    timeoutSeconds: row.timeout_seconds,
    customHeaders: row.custom_headers_json ? JSON.parse(row.custom_headers_json) : undefined,
    disableThinking: Boolean(row.disable_thinking),
    enabled: Boolean(row.enabled),
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}
