import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { TEST_DATA_DIR } from "./token-env.js";
import {
  generateToken,
  loadOrCreateAuthToken,
  maskAuthToken,
  readPersistedToken,
  rotateAuthToken,
} from "../src/security/token.js";

// 隔离数据目录：token 测试会读写 data/.auth-token。
// 注意：LOCAL_AGENT_DATA_DIR 必须在 token.ts 依赖的 paths.ts 加载前设置，
// 因此设置副作用被隔离在 token-env.ts（最先 import）。
const AUTH_TOKEN_FILE = join(TEST_DATA_DIR, ".auth-token");

const prevEnv = process.env.LOCAL_AGENT_AUTH_TOKEN;

beforeEach(() => {
  // 清除环境变量与已有令牌文件，保证每个用例从干净状态开始。
  delete process.env.LOCAL_AGENT_AUTH_TOKEN;
  rmSync(AUTH_TOKEN_FILE, { force: true });
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.LOCAL_AGENT_AUTH_TOKEN;
  else process.env.LOCAL_AGENT_AUTH_TOKEN = prevEnv;
});

describe("loadOrCreateAuthToken", () => {
  it("使用环境变量令牌", () => {
    process.env.LOCAL_AGENT_AUTH_TOKEN = "env-token-0123456789abcdef";
    expect(loadOrCreateAuthToken()).toBe("env-token-0123456789abcdef");
  });

  it("拒绝过短的环境变量令牌", () => {
    process.env.LOCAL_AGENT_AUTH_TOKEN = "short";
    expect(() => loadOrCreateAuthToken()).toThrow(/长度不足/);
  });

  it("首次调用生成并持久化 32 字节 hex 令牌", () => {
    const token = loadOrCreateAuthToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(AUTH_TOKEN_FILE, "utf8").trim()).toBe(token);
  });

  it("再次调用读取持久化令牌（不重新生成）", () => {
    const first = loadOrCreateAuthToken();
    const second = loadOrCreateAuthToken();
    expect(second).toBe(first);
  });
});

describe("maskAuthToken", () => {
  it("脱敏为 pb_**** 前缀 + 末 4 位", () => {
    const token = "0123456789abcdef0123456789abcdef";
    expect(maskAuthToken(token)).toBe(`pb_****cdef`);
  });

  it("过短令牌返回固定脱敏形式", () => {
    expect(maskAuthToken("abcd")).toBe("pb_****");
  });

  it("完整令牌不出现在脱敏结果中", () => {
    const token = generateToken();
    const masked = maskAuthToken(token);
    expect(masked).not.toContain(token);
    expect(masked).not.toContain(token.slice(4, -4));
  });
});

describe("readPersistedToken / rotateAuthToken", () => {
  it("无令牌文件时 readPersistedToken 返回 null", () => {
    expect(readPersistedToken()).toBeNull();
  });

  it("轮换生成新令牌并持久化，旧令牌失效", () => {
    const old = loadOrCreateAuthToken();
    const next = rotateAuthToken();
    expect(next).not.toBe(old);
    expect(readPersistedToken()).toBe(next);
    // 旧令牌不再被读取：新进程读取到的将是新令牌。
    expect(loadOrCreateAuthToken()).toBe(next);
  });
});
