/**
 * Vault 一致性审计与清理 CLI。
 *
 *   pnpm vault:audit       只读审计：输出问题列表（仅 Provider ID + 问题类型）。
 *   pnpm vault:cleanup     默认 dry-run：展示待清理的孤立 secret。
 *   pnpm vault:cleanup --confirm   执行清理，然后重新运行审计。
 *
 * 安全：
 * - 绝不输出任何 secret value，只输出密钥名 / Provider ID。
 * - 清理仅删除数据库中已不存在对应 Provider 的 providerKey:<id>。
 * - 不删除未知命名空间的密钥（人工处理）。
 */
import { openDatabase } from "../storage/db.js";
import { DB_PATH } from "../storage/paths.js";
import { createVault } from "../security/vault.js";
import { runVaultAudit, cleanupOrphanedSecrets } from "../services/vault-audit.js";

function banner(text: string): void {
  process.stdout.write(`\n=== ${text} ===\n`);
}

function printIssueGroup(title: string, items: string[]): void {
  process.stdout.write(`\n${title}\n`);
  if (items.length === 0) {
    process.stdout.write("- none\n");
    return;
  }
  for (const item of items) {
    process.stdout.write(`- ${item}\n`);
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "audit";
  const confirm = process.argv.includes("--confirm");

  if (command !== "audit" && command !== "cleanup") {
    process.stderr.write(`用法：node dist/cli/vault.js <audit|cleanup [--confirm]>\n`);
    process.exit(1);
  }

  const db = openDatabase(DB_PATH);
  const vault = await createVault();
  try {
    if (command === "audit") {
      const result = await runVaultAudit(db, vault);
      banner("Vault audit");
      process.stdout.write(`Vault mode: ${vault.mode}\n`);
      printIssueGroup("Orphaned secrets:", result.summary["orphaned-secret"]);
      printIssueGroup("Providers missing secrets:", result.summary["missing-secret"]);
      printIssueGroup("Dangling default provider:", result.summary["dangling-default"]);
      printIssueGroup("Providers with invalid config:", result.summary["invalid-config"]);
      if (result.unknownSecrets.length > 0) {
        printIssueGroup("Unknown-namespace secrets (not managed):", result.unknownSecrets);
      }
      process.stdout.write("\nVault audit completed\n");
      return;
    }

    // cleanup
    const result = await runVaultAudit(db, vault);
    const cleanable = result.cleanableSecrets;
    if (cleanable.length === 0) {
      process.stdout.write("没有需要清理的孤立 secret。\n");
      return;
    }

    banner("Cleanup dry-run");
    process.stdout.write("以下孤立 secret 将被删除（请确认）：\n");
    for (const key of cleanable) {
      process.stdout.write(`- ${key}\n`);
    }

    if (!confirm) {
      process.stderr.write(
        `\n未提供 --confirm，未执行任何删除。\n` +
          `如需执行，请运行：pnpm --filter @prompt-boost/local-agent vault:cleanup --confirm\n`,
      );
      process.exit(1);
    }

    const { removed } = await cleanupOrphanedSecrets(db, vault, cleanable);
    process.stdout.write(`\n已删除 ${removed.length} 个孤立 secret。\n`);

    // 清理后重新审计。
    const after = await runVaultAudit(db, vault);
    banner("Audit after cleanup");
    printIssueGroup("Orphaned secrets:", after.summary["orphaned-secret"]);
    printIssueGroup("Providers missing secrets:", after.summary["missing-secret"]);
    printIssueGroup("Dangling default provider:", after.summary["dangling-default"]);
    printIssueGroup("Providers with invalid config:", after.summary["invalid-config"]);
    if (after.unknownSecrets.length > 0) {
      printIssueGroup("Unknown-namespace secrets (not managed):", after.unknownSecrets);
    }
    process.stdout.write("\nVault audit completed\n");
  } finally {
    db.close();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[prompt-boost:vault] 失败：${message}\n`);
  process.exit(1);
});
