/**
 * background 消息响应兜底测试（jsdom）。
 * 回归：MV3 中若 handler 抛错而未调用 sendResponse，调用方 Promise 永久挂起
 * （Options 连接测试表现为"测试中…"卡死）。respond 必须保证无论成功/失败
 * 都恰好调用一次 sendResponse。
 */
import { describe, expect, it } from "vitest";
import { respond } from "./respond.js";

/** 排空所有已排队的微任务（respond 的 Promise 链 + 异步 handler 内部 await）。 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

describe("respond：后台消息响应兜底", () => {
  it("成功时把结果传给 sendResponse", async () => {
    const sent: unknown[] = [];
    const sendResponse = (r: unknown): void => {
      sent.push(r);
    };
    respond(() => Promise.resolve({ ok: true }), sendResponse);
    await flushMicrotasks();
    expect(sent).toEqual([{ ok: true }]);
  });

  it("handler 抛错时仍调用 sendResponse（不永久挂起），返回标准化 error", async () => {
    const sent: unknown[] = [];
    const sendResponse = (r: unknown): void => {
      sent.push(r);
    };
    respond(
      () => Promise.reject(new Error("settings 解析失败")),
      sendResponse,
    );
    await flushMicrotasks();
    expect(sent).toHaveLength(1);
    const res = sent[0] as { error?: { code: string; message: string } };
    expect(res.error?.code).toBe("background");
    expect(res.error?.message).toContain("settings 解析失败");
  });

  it("异步抛错（await 内部 reject）也触发 sendResponse", async () => {
    const sent: unknown[] = [];
    const sendResponse = (r: unknown): void => {
      sent.push(r);
    };
    const handler = async (): Promise<never> => {
      await Promise.resolve();
      throw new Error("getExtensionSettings 抛错");
    };
    respond(handler, sendResponse);
    await flushMicrotasks();
    expect(sent).toHaveLength(1);
    expect((sent[0] as { error?: { message: string } }).error?.message).toContain(
      "getExtensionSettings 抛错",
    );
  });
});
