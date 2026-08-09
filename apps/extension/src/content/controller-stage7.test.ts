/**
 * Stage 7 控制器测试：追问完整闭环。
 *
 * 覆盖：
 *   - 正常增强 = 1 次调用（无追问）。
 *   - clarificationMode=off：即使返回追问也直接增强。
 *   - 追问出现 → clarifying 状态（questions 渲染）。
 *   - 使用默认假设 → 直接用首轮结果，不二次调用（累计 1 次）。
 *   - 回答并增强 → 带 answers 二次调用（累计 ≤2 次）。
 *   - 追问期间可取消（dismiss → idle）。
 *   - clarifying 状态不能再次 boost。
 *   - 竞态：新会话发起后，旧会话的追问提交返回被丢弃。
 */
import { beforeEach, describe, expect, it } from "vitest";
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

interface Harness {
  controller: BoostController;
  adapter: PlatformAdapter;
  lastPayload: () => BoostUiPayload | null;
}

let lastPayload: BoostUiPayload | null = null;

function createHarness(overrides?: { settings?: Partial<BoostRequestSettings> }): Harness {
  lastPayload = null;
  const adapter = makeAdapter();
  const controller = new BoostController({
    adapter,
    getBoostSettings: async () => ({ ...SETTINGS, ...overrides?.settings }),
    saveSettings: async () => {},
    onOpenSettings: () => {},
    onState: (_state, payload) => {
      lastPayload = payload;
    },
  });
  return { controller, adapter, lastPayload: () => lastPayload };
}

/** 标准分析（可指定追问问题）。 */
function buildAnalysis(questions: Array<{ id: string; question: string; reason: string; required: boolean }>) {
  return {
    detectedTaskType: "business" as const,
    confidence: 0.9,
    scoreDimensions: {
      objective: 80, context: 40, audience: 20, outputFormat: 60,
      constraints: 30, role: 50, materials: 10, actionability: 70,
    },
    totalScore: 45,
    scoreSource: "llm" as const,
    missingInformation: ["目标用户"],
    criticalMissingInformation: questions.length > 0 ? ["目标用户"] : [],
    suggestions: ["补充背景"],
    clarificationRequired: questions.length > 0,
    clarificationQuestions: questions,
  };
}

const Q1 = { id: "q1", question: "推广的目标市场是？", reason: "影响策略选择", required: true };
const Q2 = { id: "q2", question: "预算范围？", reason: "影响方案深度", required: false };

type EnhanceMessage = {
  type?: string;
  requestId?: string;
  settings?: { clarificationAnswers?: Record<string, string> };
};

/**
 * 可编程追问 mock：
 *   - askQuestions=true：第一次 enhance（无 answers）→ 返回追问问题。
 *   - 第二次 enhance（带 answers）→ 返回最终结果（不再追问）。
 *   - holdSecond=true 时第二次响应挂起，由测试手动 resolve（用于竞态测试）。
 */
function installClarificationMock(opts?: { askQuestions?: boolean; holdSecond?: boolean }) {
  const calls: Array<{ requestId: string; hasAnswers: boolean }> = [];
  let heldResolver: ((v: unknown) => void) | null = null;
  const chrome = (globalThis as unknown as {
    chrome: { runtime: { onMessage: { addListener: (fn: (m: unknown, _s: unknown, r: (v?: unknown) => void) => boolean | undefined) => void } } };
  }).chrome;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as EnhanceMessage;
    if (msg?.type !== "boost/enhance") return false;
    const answers = msg.settings?.clarificationAnswers ?? {};
    const hasAnswers = Object.keys(answers).length > 0;
    calls.push({ requestId: msg.requestId ?? "", hasAnswers });
    const requestId = msg.requestId ?? "";
    if (!hasAnswers && opts?.askQuestions) {
      // 首轮（askQuestions）：带追问问题。
      sendResponse({
        requestId,
        response: {
          enhancedText: "增强后的推广方案（首轮）",
          analysis: buildAnalysis([Q1, Q2]),
          assumptions: ["假设为新产品"],
          provider: "openai-compatible/deepseek-v4-flash",
          model: "deepseek-v4-flash",
        },
      });
      return true;
    }
    // 无追问 / 第二轮（带 answers）：最终结果。
    const reply = {
      requestId,
      response: {
        enhancedText: hasAnswers ? "增强后的推广方案（含回答）" : "增强后的推广方案",
        analysis: buildAnalysis([]),
        assumptions: ["假设为新产品"],
        provider: "openai-compatible/deepseek-v4-flash",
        model: "deepseek-v4-flash",
      },
    };
    if (opts?.holdSecond && hasAnswers) {
      heldResolver = (v) => sendResponse(v);
      return true;
    }
    sendResponse(reply);
    return true;
  });
  return {
    calls,
    resolveSecond: () => {
      if (!heldResolver) throw new Error("second 响应未被挂起");
      heldResolver({
        requestId: calls.find((c) => c.hasAnswers)?.requestId ?? "",
        response: {
          enhancedText: "增强后的推广方案（含回答）",
          analysis: buildAnalysis([]),
          assumptions: [],
          provider: "p",
          model: "m",
        },
      });
    },
    isHeld: () => heldResolver !== null,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  installChromeMock();
});

describe("Stage 7: 调用次数控制", () => {
  it("正常增强（无追问）仅 1 次调用", async () => {
    const mock = installClarificationMock();
    const { controller, lastPayload } = createHarness();
    await controller.boost();
    expect(mock.calls).toHaveLength(1);
    expect(lastPayload()?.state).toBe("success");
  });

  it("clarificationMode=off：即使返回追问也直接增强（1 次调用）", async () => {
    const mock = installClarificationMock({ askQuestions: true });
    const { controller, lastPayload } = createHarness({ settings: { clarificationMode: "off" } });
    await controller.boost();
    expect(mock.calls).toHaveLength(1);
    expect(lastPayload()?.state).toBe("success");
    // 直接进入 success，不经过 clarifying。
    expect(lastPayload()?.clarifications).toHaveLength(0);
  });

  it("使用默认假设：直接用首轮结果，不二次调用（累计 1 次）", async () => {
    const mock = installClarificationMock({ askQuestions: true });
    const { controller, adapter, lastPayload } = createHarness();
    await controller.boost();
    expect(lastPayload()?.state).toBe("clarifying");
    expect(lastPayload()?.clarifications).toHaveLength(2);
    controller.useDefaultAssumptions();
    expect(mock.calls).toHaveLength(1); // 没有第二次调用。
    expect(lastPayload()?.state).toBe("success");
    expect(adapter.readInput()).toContain("首轮");
  });

  it("回答并增强：带 answers 二次调用（累计 ≤2 次）", async () => {
    const mock = installClarificationMock({ askQuestions: true });
    const { controller, lastPayload } = createHarness();
    await controller.boost();
    expect(lastPayload()?.state).toBe("clarifying");
    controller.setClarificationAnswer("q1", "面向中小企业");
    controller.setClarificationAnswer("q2", "预算 10 万");
    await controller.submitClarification();
    expect(mock.calls).toHaveLength(2);
    // 第二次带 answers，且不含 required 校验强制（用户可部分回答）。
    expect(mock.calls[1].hasAnswers).toBe(true);
    expect(lastPayload()?.state).toBe("success");
  });
});

describe("Stage 7: 追问状态与取消", () => {
  it("追问出现 → clarifying 状态并渲染问题", async () => {
    installClarificationMock({ askQuestions: true });
    const { controller, lastPayload } = createHarness();
    await controller.boost();
    expect(lastPayload()?.state).toBe("clarifying");
    expect(lastPayload()?.clarifications.map((q) => q.question)).toEqual([
      Q1.question,
      Q2.question,
    ]);
    // 追问期间未写回输入框。
    expect(lastPayload()?.conflictEnhancedText).toBeUndefined();
  });

  it("追问面板取消（dismiss）→ 回到 idle 且不写回", async () => {
    const mock = installClarificationMock({ askQuestions: true });
    const { controller, adapter, lastPayload } = createHarness();
    await controller.boost();
    expect(lastPayload()?.state).toBe("clarifying");
    controller.dismiss();
    expect(lastPayload()?.state).toBe("idle");
    expect(adapter.readInput()).toContain("推广方案"); // 原输入保留。
    expect(mock.calls).toHaveLength(1);
  });

  it("clarifying 状态不能再次发起 boost", async () => {
    const mock = installClarificationMock({ askQuestions: true });
    const { controller, lastPayload } = createHarness();
    await controller.boost();
    expect(lastPayload()?.state).toBe("clarifying");
    expect(controller.canBoost).toBe(false);
    await controller.boost(); // 应为 no-op。
    expect(mock.calls).toHaveLength(1);
  });
});

describe("Stage 7: 竞态保护（requestId 绑定）", () => {
  it("新会话发起后，旧会话的追问提交返回被丢弃", async () => {
    const mock = installClarificationMock({ askQuestions: true, holdSecond: true });
    const { controller, lastPayload } = createHarness();
    // 第一轮：进入 clarifying。
    await controller.boost();
    expect(lastPayload()?.state).toBe("clarifying");
    // 用户填写答案并提交（第二次调用挂起）。
    controller.setClarificationAnswer("q1", "面向中小企业");
    const submitPromise = controller.submitClarification();
    await Promise.resolve(); // 等待 submit 内部经过 getBoostSettings 微任务。
    expect(mock.isHeld()).toBe(true);
    // 用户放弃追问，发起新的 boost（新会话）。
    controller.dismiss();
    await controller.boost();
    expect(mock.calls.length).toBeGreaterThanOrEqual(2);
    // 旧会话的第二次响应此刻返回 → 应被丢弃（activeRequestId 已变化）。
    mock.resolveSecond();
    await submitPromise;
    // 状态仍是新会话的 clarifying（未被旧结果覆盖为 success）。
    expect(lastPayload()?.state).toBe("clarifying");
  });

  it("追问回答只作用于当前会话（requestId 匹配才生效）", async () => {
    const mock = installClarificationMock({ askQuestions: true });
    const { controller, lastPayload } = createHarness();
    await controller.boost();
    const firstRequestId = mock.calls[0].requestId;
    expect(firstRequestId).toBeTruthy();
    controller.setClarificationAnswer("q1", "面向中小企业");
    await controller.submitClarification();
    // 第二次调用使用相同 requestId（同一会话）。
    expect(mock.calls[1].requestId).toBe(firstRequestId);
    expect(lastPayload()?.state).toBe("success");
  });
});
