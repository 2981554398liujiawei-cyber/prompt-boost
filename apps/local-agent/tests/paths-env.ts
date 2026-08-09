/**
 * 测试路径隔离副作用模块。
 *
 * ESM 会整体提升 import，普通赋值在 import 之后才执行；paths.ts 在模块加载时
 * 就读取环境变量解析数据路径。因此必须在任何 src 模块被静态导入之前设置
 * 全部路径变量——本模块作为「最先 import 的副作用模块」保证这一点。
 *
 * 覆盖全部路径，确保测试 / Smoke Test 完全不触碰真实 data/ 目录：
 *   LOCAL_AGENT_DATA_DIR
 *   LOCAL_AGENT_DB_PATH
 *   LOCAL_AGENT_VAULT_PATH
 *   LOCAL_AGENT_MASTER_KEY_PATH
 *   LOCAL_AGENT_AUTH_TOKEN_FILE
 *
 * 同时清空 LOCAL_AGENT_VAULT_KEY，保证主密钥走临时文件生成（测试可断言），
 * 而不是继承用户环境里可能存在的密钥。
 *
 * 清理：任何 import 本模块的测试文件结束时，afterAll 自动删除临时目录，
 * 并清空路径环境变量（失败/中断时 vitest 仍会执行 afterAll 钩子）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

export const TEST_TMP_DIR = mkdtempSync(join(tmpdir(), "pb-paths-test-"));

process.env.LOCAL_AGENT_DATA_DIR = TEST_TMP_DIR;
process.env.LOCAL_AGENT_DB_PATH = join(TEST_TMP_DIR, "agent.db");
process.env.LOCAL_AGENT_VAULT_PATH = join(TEST_TMP_DIR, "vault.json");
process.env.LOCAL_AGENT_MASTER_KEY_PATH = join(TEST_TMP_DIR, "master.key");
process.env.LOCAL_AGENT_AUTH_TOKEN_FILE = join(TEST_TMP_DIR, "auth.token");
delete process.env.LOCAL_AGENT_VAULT_KEY;

afterAll(() => {
  delete process.env.LOCAL_AGENT_DATA_DIR;
  delete process.env.LOCAL_AGENT_DB_PATH;
  delete process.env.LOCAL_AGENT_VAULT_PATH;
  delete process.env.LOCAL_AGENT_MASTER_KEY_PATH;
  delete process.env.LOCAL_AGENT_AUTH_TOKEN_FILE;
  // 兜底清理：Windows 下句柄未释放可能导致 rmSync 抛 EPERM；
  // 用 try/finally 确保即便删除失败也不阻断后续钩子，并重试一次。
  try {
    rmSync(TEST_TMP_DIR, { recursive: true, force: true });
  } catch {
    setTimeout(() => {
      try {
        rmSync(TEST_TMP_DIR, { recursive: true, force: true });
      } catch {
        // 已尽力；残留空目录不影响隔离正确性，Smoke Test 后统一清理。
      }
    }, 0);
  }
});
