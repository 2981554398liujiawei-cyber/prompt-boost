/**
 * Vault 一致性审计与清理测试。
 *
 * 全部使用临时目录，绝不触碰真实 data/。
 * 验证：孤立 secret / 缺 Key / 悬空默认 / 无效配置 / 清理确认 / 输出不含 secret value。
 */
// 路径隔离副作用必须先于任何 src 模块的静态导入执行（ESM 提升）。
import "./paths-env.js";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/storage/db.js";
import { createVault } from "../src/security/vault.js";
import {
  cleanupOrphanedSecrets,
  runVaultAudit,
} from "../src/services/vault-audit.js";

// 测试用临时根目录由 paths-env.ts 统一创建并在 afterAll 删除。
// 本文件的 afterAll 只负责确保数据库句柄关闭（否则 Windows 上删除目录会 EPERM）。
const openDbs: Array<ReturnType<typeof openDatabase>> = [];

afterAll(() => {
  for (const d of openDbs) {
    try {
      d.close();
    } catch {
      // 已关闭则忽略。
    }
  }
});

let db: ReturnType<typeof openDatabase>;
let vault: Awaited<ReturnType<typeof createVault>>;

// 每个用例独立 DB 文件 + 重置 vault 文件（避免用例间 secret 泄漏）。
beforeEach(async () => {
  const d = openDatabase(join(process.env.LOCAL_AGENT_DATA_DIR!, `audit-${Math.random()}.db`));
  openDbs.push(d);
  db = d;
  const { existsSync, unlinkSync } = await import("node:fs");
  const vaultPath = process.env.LOCAL_AGENT_VAULT_PATH!;
  if (existsSync(vaultPath)) unlinkSync(vaultPath);
  vault = await createVault();
});

const baseConfig = {
  id: "p1",
  name: "P1",
  type: "openai" as const,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  timeoutSeconds: 30,
  enabled: true,
};

describe("vault audit", () => {
  it("发现孤立 secret（Vault 有 Key、数据库无 Provider）", async () => {
    await vault.setSecret("providerKey:ghost", "sk-ghost");
    const result = await runVaultAudit(db, vault);
    expect(result.summary["orphaned-secret"]).toEqual(["providerKey:ghost"]);
    expect(result.cleanableSecrets).toEqual(["providerKey:ghost"]);
  });

  it("发现缺 Key 的 Provider（数据库有、Vault 无）", async () => {
    db.upsertProvider(baseConfig);
    const result = await runVaultAudit(db, vault);
    expect(result.summary["missing-secret"]).toEqual(["p1"]);
  });

  it("发现悬空默认 Provider", async () => {
    db.setSetting("activeProvider", "nope");
    const result = await runVaultAudit(db, vault);
    expect(result.summary["dangling-default"]).toEqual(["nope"]);
  });

  it("发现无效配置（model 缺失）", async () => {
    db.upsertProvider({ ...baseConfig, model: "" });
    const result = await runVaultAudit(db, vault);
    expect(result.summary["invalid-config"]).toEqual(["p1"]);
  });

  it("一致状态无任何问题", async () => {
    db.upsertProvider(baseConfig);
    await vault.setSecret("providerKey:p1", "sk-ok");
    db.setSetting("activeProvider", "p1");
    const result = await runVaultAudit(db, vault);
    expect(result.issues).toHaveLength(0);
    expect(result.summary["orphaned-secret"]).toEqual([]);
    expect(result.summary["missing-secret"]).toEqual([]);
    expect(result.summary["dangling-default"]).toEqual([]);
  });

  it("不输出任何 secret value（只含密钥名/Provider ID）", async () => {
    await vault.setSecret("providerKey:ghost", "sk-super-secret-value-123456");
    db.upsertProvider(baseConfig);
    const result = await runVaultAudit(db, vault);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk-super-secret-value-123456");
    expect(serialized).not.toContain("sk-");
  });

  it("未知命名空间密钥不参与清理、单独列出", async () => {
    await vault.setSecret("unrelated-key", "sk-other");
    const result = await runVaultAudit(db, vault);
    expect(result.unknownSecrets).toEqual(["unrelated-key"]);
    expect(result.cleanableSecrets).toEqual([]);
  });
});

describe("vault cleanup", () => {
  it("删除孤立 secret，保留仍存在 Provider 的 secret", async () => {
    await vault.setSecret("providerKey:ghost", "sk-ghost");
    await vault.setSecret("providerKey:alive", "sk-alive");
    db.upsertProvider({ ...baseConfig, id: "alive" });

    const result = await runVaultAudit(db, vault);
    // 只清理 ghost；alive 有 Provider，绝不删除。
    const { removed } = await cleanupOrphanedSecrets(db, vault, result.cleanableSecrets);

    expect(removed).toEqual(["providerKey:ghost"]);
    expect(await vault.getSecret("providerKey:alive")).toBe("sk-alive");
    expect(await vault.hasSecret("providerKey:ghost")).toBe(false);
  });

  it("清理不触碰未知命名空间密钥", async () => {
    await vault.setSecret("providerKey:ghost", "sk-ghost");
    await vault.setSecret("unrelated-key", "sk-other");
    const result = await runVaultAudit(db, vault);
    await cleanupOrphanedSecrets(db, vault, result.cleanableSecrets);
    expect(await vault.getSecret("unrelated-key")).toBe("sk-other");
  });

  it("清理后审计为空（重新审计验证）", async () => {
    await vault.setSecret("providerKey:ghost", "sk-ghost");
    const result = await runVaultAudit(db, vault);
    await cleanupOrphanedSecrets(db, vault, result.cleanableSecrets);
    const after = await runVaultAudit(db, vault);
    expect(after.issues).toHaveLength(0);
    expect(after.summary["orphaned-secret"]).toEqual([]);
  });
});
