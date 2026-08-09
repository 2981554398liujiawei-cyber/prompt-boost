/**
 * token 测试的隔离数据目录。
 * 必须在 `../src/security/token.js`（及其依赖 paths.js）加载前设置
 * LOCAL_AGENT_DATA_DIR——ESM import 会整体提升，普通赋值在 import 之后
 * 才执行，因此把副作用放进一个最先 import 的模块。
 *
 * 测试结束时自动删除临时目录（失败/中断时 vitest 仍执行 afterAll）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

export const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "pb-token-test-"));
process.env.LOCAL_AGENT_DATA_DIR = TEST_DATA_DIR;

afterAll(() => {
  delete process.env.LOCAL_AGENT_DATA_DIR;
  // 兜底清理：Windows 下句柄未释放可能导致 rmSync 抛 EPERM；失败不阻断钩子。
  try {
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    setTimeout(() => {
      try {
        rmSync(TEST_DATA_DIR, { recursive: true, force: true });
      } catch {
        // 已尽力；残留空目录不影响隔离正确性。
      }
    }, 0);
  }
});
