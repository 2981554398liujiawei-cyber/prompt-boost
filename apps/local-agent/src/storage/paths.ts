/**
 * 本地服务数据路径（集中解析）。
 *
 * 所有路径统一从环境变量解析；任何模块不得散落读取 process.env 来定位数据：
 *
 *   LOCAL_AGENT_DATA_DIR        数据根目录（默认 ./data，相对 cwd）
 *   LOCAL_AGENT_DB_PATH         SQLite 数据库文件（默认 <DATA_DIR>/prompt-boost.db）
 *   LOCAL_AGENT_VAULT_PATH      加密 Vault 文件（默认 <DATA_DIR>/vault.enc.json）
 *   LOCAL_AGENT_MASTER_KEY_PATH 加密主密钥文件（默认 <DATA_DIR>/.vault-master-key）
 *
 * 测试 / Smoke Test 通过覆盖这四个变量即可做到完全隔离：
 * 不读取、不修改真实 data/ 目录。
 */
import { join, resolve } from "node:path";

/** 数据根目录。默认相对 cwd 的 ./data。 */
export function resolveDataDir(): string {
  const raw = process.env.LOCAL_AGENT_DATA_DIR;
  if (raw) return raw; // 绝对或相对路径按原样交给调用方；相对路径基于 cwd 解析。
  return join(process.cwd(), "data");
}

/** 默认数据根目录（未覆盖时的值）。 */
export const defaultDataDir = join(process.cwd(), "data");

/** 数据根目录（进程启动时解析一次，供各模块拼路径）。 */
export const dataDir = resolveDataDir();

/** 认证令牌文件。 */
export const AUTH_TOKEN_FILE = resolvePath("LOCAL_AGENT_AUTH_TOKEN_FILE", ".auth-token");

/** 正在运行的 local-agent PID；停止脚本只会终止该文件指向且命令行匹配的进程。 */
export const PID_FILE = resolvePath("LOCAL_AGENT_PID_FILE", "local-agent.pid");

/**
 * 解析单个数据路径：显式环境变量优先，否则 <DATA_DIR>/<file>。
 * 相对路径统一基于 cwd 解析为绝对路径（消除对工作目录的隐式依赖）。
 */
function resolvePath(envName: string, file: string): string {
  const raw = process.env[envName];
  if (raw) return resolve(raw);
  return resolve(dataDir, file);
}

/** SQLite 数据库文件。 */
export const DB_PATH = resolvePath("LOCAL_AGENT_DB_PATH", "prompt-boost.db");

/** 加密密钥存储文件（开发模式回退）。 */
export const VAULT_FILE = resolvePath("LOCAL_AGENT_VAULT_PATH", "vault.enc.json");

/** 加密密钥主密钥文件（开发模式回退，仅 dev）。 */
export const VAULT_MASTER_KEY_FILE = resolvePath(
  "LOCAL_AGENT_MASTER_KEY_PATH",
  ".vault-master-key",
);
