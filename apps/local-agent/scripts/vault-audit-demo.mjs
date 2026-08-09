// 4.1 封板演示：在临时隔离环境预置可审计状态并运行 vault audit / cleanup。
// 用法（必须与 seed 用同一临时 env）：
//   node scripts/vault-audit-demo.mjs audit
//   node scripts/vault-audit-demo.mjs cleanup --confirm
// 不输出任何 secret value，只显示 Provider ID 与问题类型。
import { openDatabase } from "../dist/storage/db.js";
import { createVault } from "../dist/security/vault.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "audit";
const db = openDatabase(process.env.LOCAL_AGENT_DB_PATH);
const vault = await createVault();

if (process.env.SEED) {
  // 预置：p1 正常；p2 缺 key；p3 无效配置；ghost 孤立 secret；nope 悬空默认。
  db.upsertProvider({ id: "p1", name: "P1", type: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", timeoutSeconds: 30, enabled: true });
  db.upsertProvider({ id: "p2", name: "P2", type: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", timeoutSeconds: 30, enabled: true });
  db.upsertProvider({ id: "p3", name: "P3", type: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "  ", timeoutSeconds: 30, enabled: true });
  await vault.setSecret("providerKey:p1", "sk-real-key-1");
  await vault.setSecret("providerKey:ghost", "sk-orphan-ghost");
  db.setSetting("activeProvider", "nope");
  db.close();
} else {
  db.close();
  const cli = fileURLToPath(new URL("../dist/cli/vault.js", import.meta.url));
  const args = [cli, mode, ...(process.argv.includes("--confirm") ? ["--confirm"] : [])];
  const r = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}
