import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { AUTH_TOKEN_MIN_LENGTH } from "@prompt-boost/shared";
import { AUTH_TOKEN_FILE } from "../storage/paths.js";
import { readPrivateText, writePrivateFileAtomic } from "./private-file.js";

/**
 * 读取或生成本地认证令牌。
 *
 * 优先级：
 * 1. 环境变量 LOCAL_AGENT_AUTH_TOKEN（显式固定，仅开发/测试）。
 * 2. data/.auth-token 文件中已存在的令牌。
 * 3. 随机生成 32 字节 hex 令牌并写入文件。
 */
export function loadOrCreateAuthToken(): string {
  const fromEnv = process.env.LOCAL_AGENT_AUTH_TOKEN;
  if (fromEnv && fromEnv.length >= AUTH_TOKEN_MIN_LENGTH) {
    return fromEnv;
  }
  if (fromEnv) {
    throw new Error(
      `LOCAL_AGENT_AUTH_TOKEN 长度不足（需要 >= ${AUTH_TOKEN_MIN_LENGTH} 字符）`,
    );
  }
  const existing = readPersistedToken();
  if (existing) return existing;

  const token = generateToken();
  persistToken(token);
  return token;
}

/** 读取持久化令牌（不存在返回 null）。 */
export function readPersistedToken(): string | null {
  if (!existsSync(AUTH_TOKEN_FILE)) return null;
  const existing = readPrivateText(AUTH_TOKEN_FILE).trim();
  return existing || null;
}

/** 生成 32 字节随机 hex 令牌。 */
export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/** 写入持久化令牌文件（chmod 0600，目录自动创建）。 */
export function persistToken(token: string): void {
  writePrivateFileAtomic(AUTH_TOKEN_FILE, token);
}

/**
 * 脱敏令牌展示：`pb_****8f2a`。
 * 仅保留前缀标识与末尾 4 位；完整令牌不出现在普通日志。
 */
export function maskAuthToken(token: string): string {
  if (token.length <= 4) return "pb_****";
  return `pb_****${token.slice(-4)}`;
}

/**
 * 轮换本地认证令牌：生成新令牌并持久化。
 * 注意：旧令牌立即失效（服务启动时只会读取新文件）。
 * 扩展需要重新配置令牌；不影响 Provider API Key（vault 独立）。
 */
export function rotateAuthToken(): string {
  const token = generateToken();
  persistToken(token);
  return token;
}
