/**
 * BoostController 测试：空输入、未找到输入框、本地服务不可用时的错误收敛。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BoostController, type BoostRequestSettings, type BoostUiPayload } from "./controller.js";
import type { PlatformAdapter } from "../platform/types.js";
import { installChromeMock } from "../testUtils/chromeMock.js";

const SETTINGS: BoostRequestSettings = {
  taskType: "auto",
  enhanceLevel: "deep",
  clarificationMode: "smart",
  outputLanguage: "auto",
};

function makeAdapter(overrides?: Partial<PlatformAdapter>): PlatformAdapter {
  const composer = document.createElement("div");
  composer.contentEditable = "true";
  composer.textContent = "帮我写一个产品推广方案";
  document.body.append(composer);
  return {
    platform: "chatgpt",
    findComposer: () => composer,
    readInput: () => composer.textContent ?? "",
    writeInput: (v) => {
      composer.textContent = v;
    },
    observe: () => () => {},
    ...overrides,
  };
}

let lastPayload: BoostUiPayload | null = null;

function makeController(adapter: PlatformAdapter) {
  lastPayload = null;
  return new BoostController({
    adapter,
    getBoostSettings: async () => SETTINGS,
    onOpenSettings: () => {},
    onState: (_state, payload) => {
      lastPayload = payload;
    },
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  installChromeMock();
});

describe("BoostController.boost", () => {
  it("输入框为空时进入 error 状态", async () => {
    const adapter = makeAdapter();
    const composer = document.querySelector("div")!;
    composer.textContent = "   ";
    const controller = makeController(adapter);
    await controller.boost();
    expect(lastPayload?.state).toBe("error");
    expect(lastPayload?.errorMessage).toContain("为空");
  });

  it("找不到输入框时进入 error 状态", async () => {
    const adapter = makeAdapter();
    adapter.findComposer = () => null;
    const controller = makeController(adapter);
    await controller.boost();
    expect(lastPayload?.state).toBe("error");
    expect(lastPayload?.errorMessage).toContain("输入框");
  });

  it("本地服务不可用（无响应）时进入 error 且不写入输入框", async () => {
    const adapter = makeAdapter();
    const composer = document.querySelector("div")!;
    const writeSpy = vi.fn();
    adapter.writeInput = writeSpy;
    const controller = makeController(adapter);
    await controller.boost();
    expect(lastPayload?.state).toBe("error");
    expect(writeSpy).not.toHaveBeenCalled();
    expect(composer.textContent).toContain("推广方案");
  });

  it("boost 后 canBoost 保持为 true（可再次发起）", async () => {
    const adapter = makeAdapter();
    const controller = makeController(adapter);
    expect(controller.canBoost).toBe(true);
    await controller.boost();
    expect(controller.canBoost).toBe(true);
  });

  it("enhance 返回体内 error 时进入 error 状态，且不把原文当增强结果写回", async () => {
    // 模拟 background 对 BoostEnhance 的响应：/v1/enhance 返回 HTTP 200 + 体内 error。
    const { chrome } = globalThis as unknown as {
      chrome: { runtime: { onMessage: { addListener: (fn: (m: unknown, _s: unknown, r: (v?: unknown) => void) => boolean | undefined) => void } } };
    };
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const msg = message as { type?: string };
      if (msg?.type === "boost/enhance") {
        sendResponse({
          requestId: (msg as { requestId?: string }).requestId,
          error: {
            ok: false,
            code: "INVALID_REQUEST",
            message: "尚未配置默认 Provider：请在扩展设置中添加并启用一个 Provider",
          },
        });
        return true;
      }
      return false;
    });

    const adapter = makeAdapter();
    const composer = document.querySelector("div")!;
    const writeSpy = vi.fn();
    adapter.writeInput = writeSpy;
    const controller = makeController(adapter);
    await controller.boost();

    expect(lastPayload?.state).toBe("error");
    // 安全消息展示给用户（统一错误映射），而非原始错误。
    expect(lastPayload?.errorMessage).toContain("AI Provider");
    expect(lastPayload?.errorMessage).not.toContain("INVALID_REQUEST");
    // 关键：绝不把用户原文当增强结果写回。
    expect(writeSpy).not.toHaveBeenCalled();
    expect(composer.textContent).toContain("推广方案");
  });
});

describe("BoostController 批次 3 修复（H/I/K/L）", () => {
  /** 可编程 enhance 响应：按发送次数返回预设 reply。 */
  function installEnhanceReply(replies: Array<Record<string, unknown>>): void {
    const { chrome } = globalThis as unknown as {
      chrome: { runtime: { onMessage: { addListener: (fn: (m: unknown, _s: unknown, r: (v?: unknown) => void) => boolean | undefined) => void } } };
    };
    let call = 0;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const msg = message as { type?: string };
      if (msg?.type === "boost/enhance") {
        const reply = replies[Math.min(call, replies.length - 1)];
        call += 1;
        sendResponse({ requestId: (msg as { requestId?: string }).requestId, ...reply });
        return true;
      }
      return false;
    });
  }

  it("L：getBoostSettings 抛错时进入 error 且提示设置读取失败（不静默）", async () => {
    const adapter = makeAdapter();
    // 数组捕获 payload：`let` 变量仅在闭包内赋值 + await 后读取会被 TS 控制流
    // 分析误收窄为 never（测试新增即存在，vitest/esbuild 不查类型所以一直能跑）。
    const seen: BoostUiPayload[] = [];
    const controller = new BoostController({
      adapter,
      getBoostSettings: async () => {
        throw new Error("settings broken");
      },
      onOpenSettings: () => {},
      onState: (_s, p) => {
        seen.push(p);
      },
    });
    await controller.boost();
    expect(seen[0]?.state).toBe("error");
    expect(seen[0]?.errorMessage).toContain("设置读取失败");
  });

  it("H：sendEnhanceRequest 抛异常时显示真实错误信息（不再硬编码连接文案）", async () => {
    const { chrome } = globalThis as unknown as {
      chrome: { runtime: { onMessage: { addListener: (fn: (m: unknown, _s: unknown, r: (v?: unknown) => void) => boolean | undefined) => void } } };
    };
    chrome.runtime.onMessage.addListener(() => {
      // 模拟 sendEnhanceRequest 的意外异常（sendMessage reject）。
      throw new Error("runtime inner failure");
    });
    const adapter = makeAdapter();
    const controller = makeController(adapter);
    await controller.boost();
    expect(lastPayload?.state).toBe("error");
    // 修复 H：不再硬编码"无法连接本地服务"；显示真实错误信息。
    expect(lastPayload?.errorMessage).toContain("runtime inner failure");
    expect(lastPayload?.errorMessage).not.toContain("无法连接本地服务");
  });

  it("I：conflict 状态下 undo 不覆盖用户新输入", async () => {
    // 增强请求期间用户修改输入 → 返回后进入 conflict。
    installEnhanceReply([
      {
        response: {
          enhancedText: "增强后的完整方案文本",
          analysis: {
            detectedTaskType: "business",
            confidence: 0.9,
            scoreDimensions: {},
            totalScore: 0,
            scoreSource: "llm",
            missingInformation: [],
            criticalMissingInformation: [],
            suggestions: [],
            clarificationRequired: false,
            clarificationQuestions: [],
          },
          assumptions: [],
        },
      },
    ]);
    const adapter = makeAdapter();
    const composer = document.querySelector("div")!;
    const controller = makeController(adapter);
    const writeSpy = vi.fn();
    adapter.writeInput = writeSpy;

    const boosting = controller.boost();
    // 请求返回前用户修改了输入（冲突触发条件）。
    composer.textContent = "用户新输入的内容";
    await boosting;

    expect(lastPayload?.state).toBe("conflict");
    // 修复 I：conflict 状态 undo 必须是无操作（否则静默覆盖用户新输入）。
    controller.undo();
    expect(writeSpy).not.toHaveBeenCalled();
    expect(composer.textContent).toBe("用户新输入的内容");
  });

  it("undo：当前输入仍是最近增强结果时恢复原文", async () => {
    installEnhanceReply([
      {
        response: {
          enhancedText: "增强后的完整方案文本",
          analysis: {
            detectedTaskType: "business",
            confidence: 0.9,
            scoreDimensions: {},
            totalScore: 0,
            scoreSource: "llm",
            missingInformation: [],
            criticalMissingInformation: [],
            suggestions: [],
            clarificationRequired: false,
            clarificationQuestions: [],
          },
          assumptions: [],
        },
      },
    ]);
    const adapter = makeAdapter();
    const composer = document.querySelector("div")!;
    const writeSpy = vi.spyOn(adapter, "writeInput");
    const controller = makeController(adapter);

    await controller.boost();
    expect(composer.textContent).toBe("增强后的完整方案文本");

    controller.undo();
    expect(writeSpy).toHaveBeenNthCalledWith(2, "帮我写一个产品推广方案");
    expect(composer.textContent).toBe("帮我写一个产品推广方案");
  });

  it("undo：增强后用户继续编辑时不覆盖用户的新内容", async () => {
    installEnhanceReply([
      {
        response: {
          enhancedText: "增强后的完整方案文本",
          analysis: {
            detectedTaskType: "business",
            confidence: 0.9,
            scoreDimensions: {},
            totalScore: 0,
            scoreSource: "llm",
            missingInformation: [],
            criticalMissingInformation: [],
            suggestions: [],
            clarificationRequired: false,
            clarificationQuestions: [],
          },
          assumptions: [],
        },
      },
    ]);
    const adapter = makeAdapter();
    const composer = document.querySelector("div")!;
    const writeSpy = vi.spyOn(adapter, "writeInput");
    const controller = makeController(adapter);

    await controller.boost();
    composer.textContent = "用户在增强后补充的新内容";
    controller.undo();

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(composer.textContent).toBe("用户在增强后补充的新内容");
  });

  it("K：dismiss() 在 conflict 分支也清空 lastError", async () => {
    installEnhanceReply([
      {
        response: {
          enhancedText: "增强后的完整方案文本",
          analysis: {
            detectedTaskType: "business",
            confidence: 0.9,
            scoreDimensions: {},
            totalScore: 0,
            scoreSource: "llm",
            missingInformation: [],
            criticalMissingInformation: [],
            suggestions: [],
            clarificationRequired: false,
            clarificationQuestions: [],
          },
          assumptions: [],
        },
      },
    ]);
    const adapter = makeAdapter();
    const composer = document.querySelector("div")!;
    const controller = makeController(adapter);
    const boosting = controller.boost();
    composer.textContent = "用户新输入的内容";
    await boosting;
    expect(lastPayload?.state).toBe("conflict");

    controller.dismiss();
    expect(lastPayload?.state).toBe("idle");
    // 修复 K：conflict 分支 dismiss 后不得残留 lastError。
    expect(lastPayload?.errorMessage).toBeUndefined();
  });
});
