/**
 * Clarification 生产链路集成测试（ClarifFix）。
 *
 * 链路：BoostController → background mock（等同 /v1/enhance 响应）→
 *       BoostUiPayload 状态 → UI 渲染判定。
 *
 * 覆盖（任务卡七）：
 *   Test1  含糊 Prompt + 问题 → clarifying + writeInput 0
 *   Test2  smart + 信息充分   → writeInput 1（不追问直接写回）
 *   Test3  off               → 无追问 UI，直接写回
 *   Test4  使用默认假设       → 仅 1 次上游调用
 *   Test5  回答并增强         → 累计 2 次上游调用
 *   Test6  取消（dismiss）    → 0 额外调用、0 写回、保留原文
 *   Test7  竞态隔离           → 新会话发起后，旧会话晚到响应被丢弃
 */
import { beforeEach, describe, expect, it } from "vitest";
import { BoostController, shouldShowClarification, type BoostRequestSettings, type BoostUiPayload } from "./controller.js";
import type { PlatformAdapter } from "../platform/types.js";
import { installChromeMock } from "../testUtils/chromeMock.js";

const SETTINGS: BoostRequestSettings = {
  taskType: "auto",
  enhanceLevel: "deep",
  clarificationMode: "smart",
  outputLanguage: "auto",
};

/** 构造一个合法的 EnhancePromptResponse（含 criticalMissingInformation）。 */
function buildResponse(overrides: {
  enhancedText?: string;
  criticalMissing?: string[];
  questions?: Array<{ id: string; question: string; reason: string; required: boolean }>;
  clarificationRequired?: boolean;
} = {}) {
  const questions = overrides.questions ?? [];
  const critical = overrides.criticalMissing ?? [];
  return {
    enhancedText: overrides.enhancedText ?? "增强后的推广方案",
    analysis: {
      detectedTaskType: "business" as const,
      confidence: 0.9,
      scoreDimensions: {
        objective: 80, context: 40, audience: 20, outputFormat: 60,
        constraints: 30, role: 50, materials: 10, actionability: 70,
      },
      totalScore: 45,
      scoreSource: "llm" as const,
      missingInformation: critical.length > 0 ? critical : ["预算"],
      criticalMissingInformation: critical,
      suggestions: ["补充背景"],
      clarificationRequired: overrides.clarificationRequired ?? (critical.length > 0),
      clarificationQuestions: questions,
    },
    assumptions: ["假设为新产品"],
    provider: "openai-compatible/deepseek-v4-flash",
    model: "deepseek-v4-flash",
  };
}

/** 可编程 background mock：按剧本返回增强响应。holdResponse 可挂起下一次。 */
function installBackgroundMock() {
  const calls: Array<{ requestId: string; hasAnswers: boolean; answers: Record<string, string> }> = [];
  let script: Array<() => unknown> = [];
  let scriptIdx = 0;
  let held: ((v: unknown) => void) | null = null;
  let heldRequestId = "";
  let holdNext = false;

  const chrome = (globalThis as unknown as {
    chrome: { runtime: { onMessage: { addListener: (fn: (m: unknown, _s: unknown, r: (v?: unknown) => void) => boolean | undefined) => void } } };
  }).chrome;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as { type?: string; requestId?: string; settings?: { clarificationAnswers?: Record<string, string> } };
    if (msg?.type !== "boost/enhance") return false;
    const answers = msg.settings?.clarificationAnswers ?? {};
    const hasAnswers = Object.keys(answers).length > 0;
    const requestId = msg.requestId ?? "";
    calls.push({ requestId, hasAnswers, answers });
    const step = script[Math.min(scriptIdx, script.length - 1)];
    scriptIdx += 1;
    if (holdNext) {
      holdNext = false;
      held = (v) => sendResponse(v);
      heldRequestId = requestId;
      return true;
    }
    sendResponse({ requestId, response: step() });
    return true;
  });

  return {
    calls,
    script(responses: Array<ReturnType<typeof buildResponse>>) {
      script = responses.map((r) => () => r);
      scriptIdx = 0;
    },
    holdNextResponse() { holdNext = true; },
    isHeld: () => held !== null,
    releaseHeld(response: ReturnType<typeof buildResponse>) {
      if (!held) throw new Error("没有挂起的响应");
      held({ requestId: heldRequestId, response });
      held = null;
    },
  };
}

interface Harness {
  controller: BoostController;
  writes: string[];
  lastPayload: () => BoostUiPayload | null;
  adapter: PlatformAdapter;
}

function createHarness(overrides?: { settings?: Partial<BoostRequestSettings> }): Harness {
  const writes: string[] = [];
  const composer = document.createElement("div");
  composer.contentEditable = "true";
  composer.textContent = "帮我做个推广方案";
  document.body.append(composer);
  const adapter: PlatformAdapter = {
    platform: "chatgpt",
    findComposer: () => composer,
    readInput: () => composer.textContent ?? "",
    writeInput: (v) => {
      writes.push(v);
      composer.textContent = v;
    },
    observe: () => () => {},
  };
  let lastPayload: BoostUiPayload | null = null;
  const controller = new BoostController({
    adapter,
    getBoostSettings: async () => ({ ...SETTINGS, ...overrides?.settings }),
    saveSettings: async () => {},
    onOpenSettings: () => {},
    onState: (_state, payload) => {
      lastPayload = payload;
    },
  });
  return { controller, writes, lastPayload: () => lastPayload, adapter };
}

const Q1 = { id: "q1", question: "推广的目标市场是？", reason: "影响策略选择", required: true };
const Q2 = { id: "q2", question: "预算范围？", reason: "影响方案深度", required: false };
const Q3 = { id: "q3", question: "期望的推广周期？", reason: "影响排期", required: false };

beforeEach(() => {
  document.body.innerHTML = "";
  installChromeMock();
});

describe("Clarification 生产链路集成", () => {
  it("Test1 含糊 Prompt + 问题 → clarifying 且不写回输入框", async () => {
    const mock = installBackgroundMock();
    mock.script([buildResponse({ criticalMissing: ["目标市场", "预算"], questions: [Q1, Q2, Q3] })]);
    const { controller, writes, lastPayload } = createHarness();

    await controller.boost();

    expect(mock.calls).toHaveLength(1);
    expect(lastPayload()?.state).toBe("clarifying");
    expect(lastPayload()?.clarifications).toHaveLength(3);
    // 追问期间绝不写回输入框。
    expect(writes).toHaveLength(0);
    expect(lastPayload()?.conflictEnhancedText).toBeUndefined();
    // 输入框保留原文。
    expect(lastPayload()?.lastBoostResult?.originalText).toBe("帮我做个推广方案");
  });

  it("Test2 smart + 信息充分 → 直接写回（1 次调用）", async () => {
    const mock = installBackgroundMock();
    mock.script([buildResponse({})]); // 无关键缺失、无问题。
    const { controller, writes, lastPayload } = createHarness();

    await controller.boost();

    expect(mock.calls).toHaveLength(1);
    expect(lastPayload()?.state).toBe("success");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe("增强后的推广方案");
  });

  it("Test3 clarificationMode=off → 无追问 UI，直接写回", async () => {
    const mock = installBackgroundMock();
    mock.script([buildResponse({ criticalMissing: ["目标市场"], questions: [Q1] })]);
    const { controller, writes, lastPayload } = createHarness({ settings: { clarificationMode: "off" } });

    await controller.boost();

    expect(mock.calls).toHaveLength(1);
    expect(lastPayload()?.state).toBe("success");
    expect(lastPayload()?.clarifications).toHaveLength(0);
    expect(writes).toHaveLength(1);
  });

  it("Test4 使用默认假设 → 仅 1 次上游调用（不再问模型）", async () => {
    const mock = installBackgroundMock();
    mock.script([buildResponse({ enhancedText: "增强后的推广方案（首轮）", criticalMissing: ["目标市场"], questions: [Q1] })]);
    const { controller, writes, lastPayload } = createHarness();

    await controller.boost();
    expect(lastPayload()?.state).toBe("clarifying");

    controller.useDefaultAssumptions();

    expect(mock.calls).toHaveLength(1); // 没有第二次调用。
    expect(lastPayload()?.state).toBe("success");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe("增强后的推广方案（首轮）");
  });

  it("Test5 回答并增强 → 累计 2 次上游调用，第二次带 answers", async () => {
    const mock = installBackgroundMock();
    mock.script([
      buildResponse({ enhancedText: "首轮", criticalMissing: ["目标市场", "预算"], questions: [Q1, Q2] }),
      buildResponse({ enhancedText: "增强后的推广方案（含回答）" }),
    ]);
    const { controller, writes, lastPayload } = createHarness();

    await controller.boost();
    expect(lastPayload()?.state).toBe("clarifying");

    controller.setClarificationAnswer("q1", "面向中小企业");
    await controller.submitClarification();

    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1].hasAnswers).toBe(true);
    expect(mock.calls[1].answers).toEqual({ q1: "面向中小企业" });
    expect(lastPayload()?.state).toBe("success");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe("增强后的推广方案（含回答）");
  });

  it("Test6 取消（dismiss）→ 无额外调用、无写回、保留原文", async () => {
    const mock = installBackgroundMock();
    mock.script([buildResponse({ criticalMissing: ["目标市场"], questions: [Q1] })]);
    const { controller, writes, adapter, lastPayload } = createHarness();

    await controller.boost();
    expect(lastPayload()?.state).toBe("clarifying");

    controller.dismiss();

    expect(mock.calls).toHaveLength(1); // 只有首轮，无额外调用。
    expect(writes).toHaveLength(0); // 无写回。
    expect(adapter.readInput()).toBe("帮我做个推广方案"); // 保留原文。
    expect(lastPayload()?.state).toBe("idle");
  });

  it("Test7 竞态隔离：新会话发起后，旧会话晚到响应被丢弃", async () => {
    const mock = installBackgroundMock();
    mock.script([
      buildResponse({ enhancedText: "首轮", criticalMissing: ["目标市场"], questions: [Q1] }),
      buildResponse({ enhancedText: "新会话结果", criticalMissing: ["预算"], questions: [Q2] }),
    ]);
    const { controller, writes, lastPayload } = createHarness();

    // 第一轮 → clarifying。
    await controller.boost();
    expect(lastPayload()?.state).toBe("clarifying");

    // 用户回答并提交（第二次调用被挂起）。
    controller.setClarificationAnswer("q1", "面向中小企业");
    mock.holdNextResponse();
    const submitPromise = controller.submitClarification();
    await Promise.resolve();
    expect(mock.isHeld()).toBe(true);

    // 用户放弃追问并发起新 Boost（新会话）。
    controller.dismiss();
    await controller.boost();
    expect(lastPayload()?.state).toBe("clarifying");

    // 旧会话的晚到响应此刻返回 → 必须被丢弃（activeRequestId 已变）。
    mock.releaseHeld(buildResponse({ enhancedText: "旧会话最终结果" }));
    await submitPromise;

    expect(lastPayload()?.state).toBe("clarifying"); // 仍是新会话的澄清状态。
    expect(writes).toHaveLength(0); // 旧结果绝不写回。
  });
});

describe("Clarification Gate（shouldShowClarification）", () => {
  const withQuestions = (n: number) =>
    ({ clarificationRequired: true, clarificationQuestions: Array.from({ length: n }, (_, i) => ({ id: `q${i}`, question: `问题${i}`, reason: "", required: false })) });

  it("off → 恒 false", () => {
    expect(shouldShowClarification("off", "deep", withQuestions(3))).toBe(false);
  });
  it("quick → 恒 false（快速档不打断用户）", () => {
    expect(shouldShowClarification("smart", "quick", withQuestions(3))).toBe(false);
  });
  it("always → 有问题即 true，无问题即 false", () => {
    expect(shouldShowClarification("always", "deep", withQuestions(1))).toBe(true);
    expect(shouldShowClarification("always", "deep", { clarificationRequired: false, clarificationQuestions: [] })).toBe(false);
  });
  it("smart → 需 clarificationRequired=true 且有问题", () => {
    expect(shouldShowClarification("smart", "deep", withQuestions(2))).toBe(true);
    expect(shouldShowClarification("smart", "deep", { clarificationRequired: true, clarificationQuestions: [] })).toBe(false);
    expect(shouldShowClarification("smart", "deep", { clarificationRequired: false, clarificationQuestions: withQuestions(1).clarificationQuestions })).toBe(false);
  });
});

describe("Clarification 设置持久化与透传", () => {
  /** 收集 background 收到的消息体（等同 HTTP 请求体的来源）。 */
  function installCaptureMock() {
    const received: Array<{ clarificationMode?: string; enhanceLevel?: string; clarificationAnswers?: Record<string, string> }> = [];
    const chrome = (globalThis as unknown as {
      chrome: { runtime: { onMessage: { addListener: (fn: (m: unknown, _s: unknown, r: (v?: unknown) => void) => boolean | undefined) => void } } };
    }).chrome;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const msg = message as { type?: string; settings?: { clarificationMode?: string; enhanceLevel?: string; clarificationAnswers?: Record<string, string> } };
      if (msg?.type !== "boost/enhance") return false;
      received.push(msg.settings ?? {});
      sendResponse({ requestId: (message as { requestId?: string }).requestId, response: buildResponse({}) });
      return true;
    });
    return received;
  }

  it("smart 设置透传到请求体并经受 refresh 持久化", async () => {
    const received = installCaptureMock();
    const { controller } = createHarness({ settings: { clarificationMode: "smart", enhanceLevel: "deep" } });
    await controller.boost();
    expect(received[0].clarificationMode).toBe("smart");
    expect(received[0].enhanceLevel).toBe("deep");

    // 模拟 Options 页/菜单持久化后再次发起：设置仍生效。
    const { controller: c2 } = createHarness({ settings: { clarificationMode: "smart" } });
    await c2.refresh();
    await c2.boost();
    expect(received[1].clarificationMode).toBe("smart");
  });

  it("off / always 设置透传到请求体", async () => {
    const received = installCaptureMock();
    const { controller: offC } = createHarness({ settings: { clarificationMode: "off" } });
    await offC.boost();
    expect(received[0].clarificationMode).toBe("off");

    const { controller: alwaysC } = createHarness({ settings: { clarificationMode: "always", enhanceLevel: "expert" } });
    await alwaysC.boost();
    expect(received[1].clarificationMode).toBe("always");
    expect(received[1].enhanceLevel).toBe("expert");
  });

  it("刷新（refresh）不触发任何增强请求（仅同步设置）", async () => {
    const received = installCaptureMock();
    const { controller } = createHarness({ settings: { clarificationMode: "smart" } });
    await controller.refresh();
    await controller.refresh();
    expect(received).toHaveLength(0);
  });
});
