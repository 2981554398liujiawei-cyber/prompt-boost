/**
 * 环境配置。本地服务只监听 loopback。
 */
import { DB_PATH } from "./storage/paths.js";

export interface EnvConfig {
  host: string;
  port: number;
  dbPath: string;
  logVerbose: boolean;
}

const parsePort = (raw: string | undefined, fallback: number): number => {
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
};

/** 读取环境变量并计算默认值。host 固定为 127.0.0.1，不允许 0.0.0.0。 */
export function loadEnv(): EnvConfig {
  const host = process.env.LOCAL_AGENT_HOST ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`LOCAL_AGENT_HOST 只允许 127.0.0.1 / localhost，当前为：${host}`);
  }
  // 数据路径统一由 storage/paths.ts 解析：LOCAL_AGENT_DB_PATH 优先，
  // 否则 <LOCAL_AGENT_DATA_DIR>/prompt-boost.db，否则 ./data/prompt-boost.db。
  return {
    host,
    port: parsePort(process.env.LOCAL_AGENT_PORT, 8787),
    dbPath: DB_PATH,
    logVerbose: process.env.LOG_VERBOSE === "true",
  };
}
