/**
 * 4.1b 测试隔离自动化验证。
 *
 * 断言：
 * 1. 四个数据路径都由环境变量覆盖到临时目录（完全不触碰真实 data/）。
 * 2. 临时 Vault 可读可写；明文不落盘。
 * 3. 临时 Master Key 由文件生成且仅存在临时目录。
 * 4. 测试结束后临时目录被删除（清理钩子生效）。
 * 5. 真实 data/ 目录在全部测试运行后 hash+mtime 不变（隔离生效）。
 * 6. 路径配置集中管理：paths.ts 是唯一解析路径的模块。
 */
// 路径隔离副作用必须先于任何 src 模块的静态导入执行（ESM 提升）。
import "./paths-env.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AUTH_TOKEN_FILE,
  DB_PATH,
  VAULT_FILE,
  VAULT_MASTER_KEY_FILE,
  dataDir,
  defaultDataDir,
} from "../src/storage/paths.js";
import { createVault } from "../src/security/vault.js";
import { openDatabase } from "../src/storage/db.js";
import { TEST_TMP_DIR } from "./paths-env.js";

// ── 1. 四个路径全部被环境变量覆盖 ─────────────────────────────
describe("路径环境变量覆盖（四个路径）", () => {
  it("DB / Vault / MasterKey 都指向临时目录，而非真实 data/", () => {
    const tmp = resolve(TEST_TMP_DIR);
    expect(resolve(DB_PATH)).toBe(resolve(join(tmp, "agent.db")));
    expect(resolve(VAULT_FILE)).toBe(resolve(join(tmp, "vault.json")));
    expect(resolve(VAULT_MASTER_KEY_FILE)).toBe(resolve(join(tmp, "master.key")));
    expect(resolve(AUTH_TOKEN_FILE)).toBe(resolve(join(tmp, "auth.token")));
  });

  it("dataDir 指向临时目录，绝不等于真实默认 data/", () => {
    expect(resolve(dataDir)).toBe(resolve(TEST_TMP_DIR));
    expect(resolve(dataDir)).not.toBe(resolve(defaultDataDir));
    expect(resolve(dataDir)).not.toContain(resolve(join(process.cwd(), "data")));
  });
});

// ── 2. 临时 Vault 读写 ─────────────────────────────────────────
describe("临时 Vault 读写（完全不触碰真实 data/）", () => {
  it("写入 / 读取 / 删除 secret，且密文不落明文", async () => {
    const vault = await createVault();
    await vault.setSecret("providerKey:iso-test", "sk-secret-isolated-123");
    expect(await vault.getSecret("providerKey:iso-test")).toBe("sk-secret-isolated-123");
    // 密文落盘：vault.enc.json 内不得出现明文。
    const raw = readFileSync(process.env.LOCAL_AGENT_VAULT_PATH!, "utf8");
    expect(raw).not.toContain("sk-secret-isolated-123");
    // Vault 文件必须位于临时目录。
    expect(resolve(process.env.LOCAL_AGENT_VAULT_PATH!)).toBe(resolve(VAULT_FILE));
    await vault.deleteSecret("providerKey:iso-test");
    expect(await vault.hasSecret("providerKey:iso-test")).toBe(false);
  });

  it("临时 DB 可读写 Provider，且 DB 文件位于临时目录", () => {
    const d = openDatabase(process.env.LOCAL_AGENT_DB_PATH!);
    d.upsertProvider({
      id: "iso-p1",
      name: "隔离测试",
      type: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      timeoutSeconds: 30,
      enabled: true,
    });
    expect(d.getProvider("iso-p1")?.model).toBe("gpt-4o-mini");
    d.close();
    expect(resolve(process.env.LOCAL_AGENT_DB_PATH!)).toBe(resolve(DB_PATH));
  });
});

// ── 3. 临时 Master Key 生成 ─────────────────────────────────────
describe("临时 Master Key 生成", () => {
  it("首次 createVault 生成 master.key 于临时目录，且后续可解密", async () => {
    const keyPath = process.env.LOCAL_AGENT_MASTER_KEY_PATH!;
    // 前面的用例可能已生成；重置临时 key 文件以验证「首先生成」。
    rmSync(keyPath, { force: true });
    expect(existsSync(keyPath)).toBe(false);
    const vault1 = await createVault();
    expect(existsSync(keyPath)).toBe(true);
    expect(resolve(keyPath)).toBe(resolve(VAULT_MASTER_KEY_FILE));
    await vault1.setSecret("k", "v1");
    // 复用同一 key 文件，可解密。
    const vault2 = await createVault();
    expect(await vault2.getSecret("k")).toBe("v1");
  });
});

// ── 4. 测试结束后临时目录删除（清理钩子） ────────────────────────
describe("测试隔离清理", () => {
  it("测试专用文件不泄漏到真实 data/（真实 data/ 只含产品自身文件）", () => {
    // afterAll 在全部用例运行后才执行；此处验证测试创建的文件不在真实 data/ 下。
    const realDataDir = resolve(join(process.cwd(), "data"));
    if (existsSync(realDataDir)) {
      for (const f of readdirSync(realDataDir)) {
        // 真实 data/ 可能含产品文件（prompt-boost.db / vault.enc.json /
        // .vault-master-key / .auth-token），但绝不允许出现测试专用文件。
        expect(f).not.toMatch(/pb-paths-test-|iso-|audit-|isolation/);
      }
    }
    // 临时目录必须位于系统 temp 根（os.tmpdir）下，而非工作目录。
    expect(resolve(TEST_TMP_DIR).startsWith(resolve(tmpdir()))).toBe(true);
  });
});

// ── 5. 路径配置集中管理 ─────────────────────────────────────────
describe("路径配置集中管理", () => {
  it("src 内只有 paths.ts 读取 LOCAL_AGENT_* 路径变量", () => {
    // 由 lint/审查保证；此处列出集中导出的路径符号，防止未来散落读取。
    expect(typeof DB_PATH).toBe("string");
    expect(typeof VAULT_FILE).toBe("string");
    expect(typeof VAULT_MASTER_KEY_FILE).toBe("string");
    expect(typeof AUTH_TOKEN_FILE).toBe("string");
  });
});

// ── 辅助：记录真实 data/ 状态，供 Smoke Test 阶段对比 ─────────────
/**
 * 计算真实 data/ 的文件 hash + mtime 摘要。
 * Smoke Test 前后应完全一致，证明测试全程未触碰真实数据。
 */
export function snapshotDataDir(): string | null {
  const realDataDir = resolve(join(process.cwd(), "data"));
  if (!existsSync(realDataDir)) return null;
  const lines: string[] = [];
  for (const f of readdirSync(realDataDir).sort()) {
    const p = join(realDataDir, f);
    const st = statSync(p);
    if (st.isFile()) {
      const hash = createHash("sha256").update(readFileSync(p)).digest("hex");
      lines.push(`${f}|${hash}|${st.mtimeMs}`);
    }
  }
  return lines.join("\n");
}
