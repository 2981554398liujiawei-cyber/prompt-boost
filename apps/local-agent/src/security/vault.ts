/**
 * 安全存储抽象（Vault）。
 *
 * 生产模式：系统凭证库（Windows Credential Manager / macOS Keychain / Linux Secret Service）。
 *   - 通过 `keytar`（可选依赖）实现；未安装时自动降级。
 * 开发模式：AES-256-GCM 加密文件（data/vault.enc.json）。
 *   - 密钥由 PBKDF2 从主密钥派生；主密钥来自环境变量或 data/.vault-master-key（0600）。
 *   - 明文永不落盘；删除密钥文件即可作废全部密钥。
 *
 * 启动日志中会明确打印当前模式（system / file / unsupported）。
 * 生产发布前必须启用系统凭证库（见 docs/SECURITY.md）。
 */
import { randomBytes, createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { VAULT_FILE, VAULT_MASTER_KEY_FILE } from "../storage/paths.js";
import { hardenPrivateFile, readPrivateText, writePrivateFileAtomic } from "./private-file.js";

export type VaultMode = "system" | "file" | "unsupported";

const PBKDF2_ITERATIONS = 210_000;
const KEY_LENGTH = 32;
const ALGORITHM = "aes-256-gcm";

export interface Vault {
  mode: VaultMode;
  /** 读取密钥明文（仅存在于进程内存）。 */
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  deleteSecret(key: string): Promise<void>;
  hasSecret(key: string): Promise<boolean>;
  /** 列出所有密钥名（用于一致性审计；不返回密钥值）。 */
  listKeys(): Promise<string[]>;
}

interface KeytarApi {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>;
}

/** 尝试加载 keytar（可选依赖），失败返回 null。类型声明见 src/types/keytar.d.ts。 */
async function tryLoadKeytar(): Promise<KeytarApi | null> {
  try {
    const loaded = await import("keytar");
    // keytar 是 CommonJS；Node ESM 动态导入时运行时实现位于 default，类型声明则是
    // named exports。两种加载形态都归一为同一个接口。
    const shape = loaded as unknown as KeytarApi & { default?: KeytarApi };
    return shape.default ?? shape;
  } catch {
    return null;
  }
}

interface VaultFileShape {
  version: 1;
  entries: Record<string, { iv: string; tag: string; data: string }>;
}

async function createFileVault(): Promise<Vault> {
  mkdirSync(dirname(VAULT_FILE), { recursive: true });

  const masterKey = await getOrCreateMasterKey();

  const load = (): VaultFileShape => {
    if (!existsSync(VAULT_FILE)) {
      return { version: 1, entries: {} };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readPrivateText(VAULT_FILE));
    } catch (err) {
      throw new Error("Vault 文件损坏，已停止读取以避免覆盖现有密钥", { cause: err });
    }
    if (!isVaultFileShape(parsed)) {
      throw new Error("Vault 文件格式无效，已停止读取以避免覆盖现有密钥");
    }
    return parsed;
  };

  const persist = (shape: VaultFileShape): void => {
    writePrivateFileAtomic(VAULT_FILE, JSON.stringify(shape));
  };

  const encrypt = (plain: string): { iv: string; tag: string; data: string } => {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, masterKey, iv);
    const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data: data.toString("hex") };
  };

  const decrypt = (entry: { iv: string; tag: string; data: string }): string | null => {
    try {
      const decipher = createDecipheriv(
        ALGORITHM,
        masterKey,
        Buffer.from(entry.iv, "hex"),
      );
      decipher.setAuthTag(Buffer.from(entry.tag, "hex"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(entry.data, "hex")),
        decipher.final(),
      ]);
      return plain.toString("utf8");
    } catch (err) {
      throw new Error("Vault 密钥无法解密，数据可能已损坏或主密钥不匹配", {
        cause: err,
      });
    }
  };

  return {
    mode: "file",
    async getSecret(key) {
      const entry = load().entries[key];
      return entry ? decrypt(entry) : null;
    },
    async setSecret(key, value) {
      const shape = load();
      shape.entries[key] = encrypt(value);
      persist(shape);
    },
    async deleteSecret(key) {
      const shape = load();
      delete shape.entries[key];
      persist(shape);
    },
    async hasSecret(key) {
      return Boolean(load().entries[key]);
    },
    async listKeys() {
      return Object.keys(load().entries);
    },
  };
}

async function getOrCreateMasterKey(): Promise<Buffer> {
  const fromEnv = process.env.LOCAL_AGENT_VAULT_KEY;
  if (fromEnv && fromEnv.length >= 16) {
    return deriveMasterKey(fromEnv);
  }

  if (existsSync(VAULT_MASTER_KEY_FILE)) {
    return deriveMasterKey(readPrivateText(VAULT_MASTER_KEY_FILE).trim());
  }

  const secret = randomBytes(32).toString("hex");
  writePrivateFileAtomic(VAULT_MASTER_KEY_FILE, secret);
  return deriveMasterKey(secret);
}

function deriveMasterKey(secret: string): Buffer {
  const salt = createHash("sha256").update("prompt-boost-vault-v1").digest();
  return pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, "sha256");
}

/** 生产环境：尝试系统凭证库；失败回退加密文件并标注。 */
export async function createVault(): Promise<Vault> {
  const keytar = await tryLoadKeytar();
  if (keytar && process.env.NODE_ENV !== "test") {
    const systemVault: Vault = {
      mode: "system",
      getSecret: (key) => keytar.getPassword(SERVICE_NAME, key),
      setSecret: (key, value) => keytar.setPassword(SERVICE_NAME, key, value),
      deleteSecret: async (key) => {
        await keytar.deletePassword(SERVICE_NAME, key);
      },
      hasSecret: async (key) => Boolean(await keytar.getPassword(SERVICE_NAME, key)),
      listKeys: async () => {
        const accounts = await keytar.findCredentials(SERVICE_NAME);
        return accounts.map((a) => a.account);
      },
    };
    let systemAvailable = false;
    try {
      // 仅能 import 并不代表系统凭证后端工作正常。
      await keytar.findCredentials(SERVICE_NAME);
      systemAvailable = true;
    } catch {
      // 系统凭证库不可用时继续使用加密文件；日志中的 mode 会明确显示降级。
    }
    if (systemAvailable) {
      // 升级后把旧加密文件中的值无损复制到系统凭证库，避免“安装 keytar 后 Key 消失”。
      if (existsSync(VAULT_FILE)) {
        const fileVault = await createFileVault();
        for (const key of await fileVault.listKeys()) {
          if (await systemVault.hasSecret(key)) continue;
          const value = await fileVault.getSecret(key);
          if (value === null) throw new Error(`Vault 迁移失败：${key} 无法解密`);
          await systemVault.setSecret(key, value);
        }
        // 所有值成功迁移后移除旧加密副本与其主密钥，避免长期保留第二份凭据。
        hardenPrivateFile(VAULT_FILE);
        unlinkSync(VAULT_FILE);
        if (existsSync(VAULT_MASTER_KEY_FILE)) {
          hardenPrivateFile(VAULT_MASTER_KEY_FILE);
          unlinkSync(VAULT_MASTER_KEY_FILE);
        }
      }
      return systemVault;
    }
  }

  const fileVault = await createFileVault();
  if (process.env.NODE_ENV === "production") {
    return { ...fileVault, mode: "unsupported" as const };
  }
  return fileVault;
}

const SERVICE_NAME = "com.promptboost.local-agent";

function isVaultFileShape(value: unknown): value is VaultFileShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<VaultFileShape>;
  if (candidate.version !== 1 || !candidate.entries || typeof candidate.entries !== "object") {
    return false;
  }
  return Object.values(candidate.entries).every(
    (entry) =>
      Boolean(entry) &&
      typeof entry.iv === "string" &&
      typeof entry.tag === "string" &&
      typeof entry.data === "string" &&
      /^[0-9a-f]+$/i.test(entry.iv) &&
      /^[0-9a-f]+$/i.test(entry.tag) &&
      /^[0-9a-f]*$/i.test(entry.data),
  );
}
