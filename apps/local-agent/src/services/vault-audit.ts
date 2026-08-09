/**
 * Vault 一致性审计与清理。
 *
 * 检查五类不一致：
 *   1. Vault 中存在但数据库没有对应 Provider 的孤立 secret（providerKey:<id>）。
 *   2. 数据库 Provider 存在但 Vault 中没有 API Key。
 *   3. 默认 Provider（activeProvider）不存在于数据库。
 *   4. Provider 引用无效配置（model / baseUrl 缺失或非法）。
 *   5. （隐含）未知命名空间的 secret 不参与审计，但清理时列出以便人工处理。
 *
 * 安全：审计与清理都绝不输出任何 secret value，只输出 Provider ID 与问题类型。
 * 清理必须显式 --confirm 才执行；默认仅展示待删列表（dry-run）。
 */
import type { ProviderConfig } from "@prompt-boost/shared";
import type { DbHandle } from "../storage/db.js";
import type { Vault } from "../security/vault.js";

const PROVIDER_KEY_PREFIX = "providerKey:";
const ACTIVE_PROVIDER_KEY = "activeProvider";

export type AuditIssueType =
  | "orphaned-secret"
  | "missing-secret"
  | "dangling-default"
  | "invalid-config";

export interface AuditIssue {
  /** 问题涉及的 Provider ID（无对应 Provider 时为 null）。 */
  providerId: string | null;
  type: AuditIssueType;
  /** 补充说明（如缺失的字段），不含 secret value。 */
  detail: string;
}

export interface AuditResult {
  issues: AuditIssue[];
  /** 按类型分组（去重后）。 */
  summary: Record<AuditIssueType, string[]>;
  /** Vault 中与 Provider 无关的未知 secret 名（不含值）。 */
  unknownSecrets: string[];
  /** 可被清理的孤立 secret 名（不含值）。 */
  cleanableSecrets: string[];
}

/** 校验 Provider 配置是否有效（model 必填；baseUrl 规则由 provider 构造器执行）。 */
function invalidConfigReason(config: ProviderConfig): string | null {
  if (!config.model || !config.model.trim()) return "model 缺失";
  return null;
}

export async function runVaultAudit(db: DbHandle, vault: Vault): Promise<AuditResult> {
  const configs = db.listProviders().map(toConfig);
  const configIds = new Set(configs.map((c) => c.id));
  const allKeys = await vault.listKeys();

  const issues: AuditIssue[] = [];
  const cleanable: string[] = [];
  const unknown: string[] = [];

  for (const key of allKeys) {
    if (!key.startsWith(PROVIDER_KEY_PREFIX)) {
      unknown.push(key);
      continue;
    }
    const providerId = key.slice(PROVIDER_KEY_PREFIX.length);
    if (!configIds.has(providerId)) {
      issues.push({
        providerId,
        type: "orphaned-secret",
        detail: "Vault 中存在该密钥但数据库没有对应 Provider",
      });
      cleanable.push(key);
    }
  }

  for (const config of configs) {
    const hasKey = await vault.hasSecret(`${PROVIDER_KEY_PREFIX}${config.id}`);
    if (!hasKey) {
      issues.push({
        providerId: config.id,
        type: "missing-secret",
        detail: "Provider 存在但 Vault 中没有 API Key",
      });
    }
    const reason = invalidConfigReason(config);
    if (reason) {
      issues.push({
        providerId: config.id,
        type: "invalid-config",
        detail: reason,
      });
    }
  }

  // 默认 Provider 悬空检查。
  const activeProviderId = db.getSetting(ACTIVE_PROVIDER_KEY);
  if (activeProviderId) {
    if (!configIds.has(activeProviderId)) {
      issues.push({
        providerId: activeProviderId,
        type: "dangling-default",
        detail: "默认 Provider 不存在于数据库",
      });
    }
  }

  const summary = {
    "orphaned-secret": cleanable,
    "missing-secret": issues
      .filter((i) => i.type === "missing-secret")
      .map((i) => i.providerId as string),
    "dangling-default": issues
      .filter((i) => i.type === "dangling-default")
      .map((i) => i.providerId as string),
    "invalid-config": issues
      .filter((i) => i.type === "invalid-config")
      .map((i) => i.providerId as string),
  };

  return { issues, summary, unknownSecrets: unknown, cleanableSecrets: cleanable };
}

/** 清理孤立 secret。不删除仍存在 Provider 的 secret；不删除未知命名空间密钥。 */
export async function cleanupOrphanedSecrets(
  db: DbHandle,
  vault: Vault,
  cleanable: string[],
): Promise<{ removed: string[] }> {
  const configs = db.listProviders().map(toConfig);
  const configIds = new Set(configs.map((c) => c.id));
  const removed: string[] = [];
  for (const key of cleanable) {
    if (!key.startsWith(PROVIDER_KEY_PREFIX)) continue;
    const providerId = key.slice(PROVIDER_KEY_PREFIX.length);
    // 防御：绝不在清理时删除数据库仍存在的 Provider 的 secret。
    if (configIds.has(providerId)) continue;
    await vault.deleteSecret(key);
    removed.push(key);
  }
  return { removed };
}

function toConfig(row: {
  id: string;
  type: string;
  name: string;
  base_url: string;
  model: string;
  timeout_seconds: number;
  custom_headers_json: string | null;
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
    enabled: Boolean(row.enabled),
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}
