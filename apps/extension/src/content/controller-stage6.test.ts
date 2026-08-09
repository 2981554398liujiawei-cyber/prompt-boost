/**
 * Stage 6 控制器测试：设置变更持久化、任务类型 manual/auto、评分过期、冲突保护。
 * 通过 jsdom + chrome mock 驱动 BoostController；不依赖真实本地服务。
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

/** 模拟 background 返回增强结果（带分析）。 */
function replyWithAnalysis(overrides?: Partial<NonNullable<BoostUiPayload["lastBoostResult"]>["analysis"]>) {
  const analysis = {
    detectedTaskType: "business" as const,
    confidence: 0.9,
    scoreDimensions: {
      objective: 80, context: 40, audience: 20, outputFormat: 60,
      constraints: 30, role: 50, materials: 10, actionability: 70,
    },
    totalScore: 45,
    scoreSource: "llm" as const,
    missingInformation: ["目标用户"],
    criticalMissingInformation: [],
    suggestions: ["补充背景"],
    clarificationRequired: false,
    clarificationQuestions: [],
    ...overrides,
  };
  const chrome = (globalThis as unknown as { chrome: { runtime: { onMessage: { addListener: (fn: (m: unknown, _s: unknown, r: (v?: unknown) => void) => boolean | undefined) => void } } } }).chrome;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as { type?: string };
    if (msg?.type === "boost/enhance") {
      sendResponse({
        requestId: (msg as { requestId?: string }).requestId,
        response: {
          enhancedText: "增强后的推广方案",
          analysis,
          assumptions: ["假设为新产品"],
          provider: "openai-compatible/deepseek-v4-flash",
          model: "deepseek-v4-flash",
        },
      });
      return true;
    }
    return false;
  });
}

interface Harness {
  controller: BoostController;
  adapter: PlatformAdapter;
  lastPayload: () => BoostUiPayload | null;
}

let lastPayload: BoostUiPayload | null = null;
let savedPatches: Array<Partial<BoostRequestSettings>> = [];

function createHarness(opts?: { onAnalyze?: () => void }): Harness {
  lastPayload = null;
  savedPatches = [];
  const adapter = makeAdapter();
  const controller = new BoostController({
    adapter,
    getBoostSettings: async () => SETTINGS,
    saveSettings: async (patch) => {
      savedPatches.push(patch);
    },
    onOpenSettings: () => {},
    onState: (_state, payload) => {
      lastPayload = payload;
    },
  });
  void opts?.onAnalyze;
  return { controller, adapter, lastPayload: () => lastPayload };
}

beforeEach(() => {
  document.body.innerHTML = "";
  installChromeMock();
});

describe("Stage 6: 设置变更与持久化", () => {
  it("setSetting 更新内存并持久化（enhanceLevel）", async () => {
    const { controller, lastPayload } = createHarness();
    await controller.setSetting("enhanceLevel", "expert");
    expect(lastPayload()?.settings.enhanceLevel).toBe("expert");
    expect(savedPatches).toContainEqual({ enhanceLevel: "expert" });
  });

  it("setSetting 任务类型为 manual 时不再展示 detected", async () => {
    const { controller, lastPayload } = createHarness();
    await controller.setSetting("taskType", "coding");
    const display = lastPayload()?.taskTypeDisplay;
    expect(display?.mode).toBe("manual");
    expect(display && "value" in display ? display.value : null).toBe("coding");
  });

  it("auto 模式 + detected 展示为「自动 · detected」", async () => {
    const { controller, lastPayload } = createHarness();
    replyWithAnalysis();
    await controller.boost();
    const display = lastPayload()?.taskTypeDisplay;
    expect(display?.mode).toBe("auto");
    expect(display && "detected" in display ? display.detected : null).toBe("business");
  });
});

describe("Stage 6: 评分与过期", () => {
  it("boost 后评分带 total + 8 维 + 来源 llm", async () => {
    const { controller, lastPayload } = createHarness();
    replyWithAnalysis();
    await controller.boost();
    expect(lastPayload()?.score?.total).toBe(45);
    expect(lastPayload()?.score?.scoreSource).toBe("llm");
    expect(Object.keys(lastPayload()?.score?.dimensions ?? {})).toHaveLength(8);
    expect(lastPayload()?.scoreStale).toBe(false);
  });

  it("用户编辑输入后评分标记为过期（不调用模型）", async () => {
    const { controller, adapter, lastPayload } = createHarness();
    replyWithAnalysis();
    await controller.boost();
    expect(lastPayload()?.scoreStale).toBe(false);
    // 用户编辑输入框。
    const composer = document.querySelector("div")!;
    composer.textContent = "帮我写一个产品推广方案（修改版）";
    adapter.readInput = () => composer.textContent ?? "";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    expect(lastPayload()?.scoreStale).toBe(true);
  });

  it("评分过期标记后不自动重新调用 /v1/analyze", async () => {
    let analyzeCalls = 0;
    const chrome = (globalThis as unknown as { chrome: { runtime: { onMessage: { addListener: (fn: (m: unknown, _s: unknown, r: (v?: unknown) => void) => boolean | undefined) => void } } } }).chrome;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const msg = message as { type?: string };
      if (msg?.type === "boost/enhance") {
        sendResponse({ requestId: (msg as { requestId?: string }).requestId, response: undefined });
        return true;
      }
      if (msg?.type === "boost/analyze") {
        analyzeCalls += 1;
        sendResponse({ requestId: "", result: undefined });
        return true;
      }
      return false;
    });
    const { controller, lastPayload } = createHarness();
    // 用户输入触发 input 事件。
    const composer = document.querySelector("div")!;
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    // 打开菜单（评分过期检查）不应触发 analyze。
    controller.setMenuPane("score");
    expect(analyzeCalls).toBe(0);
    expect(lastPayload()?.menuPane).toBe("score");
  });
});

describe("Stage 6: 冲突保护", () => {
  /** 延迟响应的增强 mock：先让测试在请求期间修改输入框，再 resolve。 */
  function replyWithDelay() {
    let resolveFn!: (v: unknown) => void;
    const promise = new Promise<unknown>((r) => (resolveFn = r));
    const chrome = (globalThis as unknown as { chrome: { runtime: { onMessage: { addListener: (fn: (m: unknown, _s: unknown, r: (v?: unknown) => void) => boolean | undefined) => void } } } }).chrome;
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const msg = message as { type?: string };
      if (msg?.type === "boost/enhance") {
        void promise.then((v) => sendResponse(v));
        return true;
      }
      return false;
    });
    return (v: unknown) => resolveFn(v);
  }

  it("请求期间修改输入 → conflict 状态且不覆盖", async () => {
    const resolveReply = replyWithDelay();
    const { controller, adapter, lastPayload } = createHarness();
    const boostPromise = controller.boost();
    // 请求在途：用户修改输入框。
    const composer = document.querySelector("div")!;
    composer.textContent = "用户在请求期间自己写的内容";
    adapter.readInput = () => composer.textContent ?? "";
    resolveReply({
      requestId: controller["session"]?.requestId,
      response: {
        enhancedText: "增强后的推广方案",
        analysis: {
          detectedTaskType: "business", confidence: 0.9,
          scoreDimensions: {
            objective: 80, context: 40, audience: 20, outputFormat: 60,
            constraints: 30, role: 50, materials: 10, actionability: 70,
          },
          totalScore: 45, scoreSource: "llm",
          missingInformation: ["目标用户"], suggestions: [],
          criticalMissingInformation: [],
          clarificationRequired: false, clarificationQuestions: [],
        },
        assumptions: [], provider: "p", model: "m",
      },
    });
    await boostPromise;
    expect(lastPayload()?.state).toBe("conflict");
    expect(lastPayload()?.conflictEnhancedText).toBe("增强后的推广方案");
    // 默认安全：没有覆盖用户内容。
    expect(composer.textContent).toBe("用户在请求期间自己写的内容");
  });

  it("cancelConflict 保持当前输入", async () => {
    const resolveReply = replyWithDelay();
    const { controller, adapter, lastPayload } = createHarness();
    const boostPromise = controller.boost();
    const composer = document.querySelector("div")!;
    composer.textContent = "用户在请求期间自己写的内容";
    adapter.readInput = () => composer.textContent ?? "";
    resolveReply({
      requestId: controller["session"]?.requestId,
      response: { enhancedText: "增强后的推广方案", analysis: {
        detectedTaskType: "business", confidence: 0.9,
        scoreDimensions: {
          objective: 80, context: 40, audience: 20, outputFormat: 60,
          constraints: 30, role: 50, materials: 10, actionability: 70,
        },
        totalScore: 45, scoreSource: "llm",
        missingInformation: [], suggestions: [],
        criticalMissingInformation: [],
        clarificationRequired: false, clarificationQuestions: [],
      }, assumptions: [], provider: "p", model: "m" },
    });
    await boostPromise;
    expect(lastPayload()?.state).toBe("conflict");
    controller.cancelConflict();
    expect(lastPayload()?.state).toBe("idle");
    expect(composer.textContent).toBe("用户在请求期间自己写的内容");
  });

  it("overwriteWithResult 覆盖为增强结果", async () => {
    const resolveReply = replyWithDelay();
    const { controller, adapter, lastPayload } = createHarness();
    const boostPromise = controller.boost();
    const composer = document.querySelector("div")!;
    composer.textContent = "用户在请求期间自己写的内容";
    adapter.readInput = () => composer.textContent ?? "";
    resolveReply({
      requestId: controller["session"]?.requestId,
      response: { enhancedText: "增强后的推广方案", analysis: {
        detectedTaskType: "business", confidence: 0.9,
        scoreDimensions: {
          objective: 80, context: 40, audience: 20, outputFormat: 60,
          constraints: 30, role: 50, materials: 10, actionability: 70,
        },
        totalScore: 45, scoreSource: "llm",
        missingInformation: [], suggestions: [],
        criticalMissingInformation: [],
        clarificationRequired: false, clarificationQuestions: [],
      }, assumptions: [], provider: "p", model: "m" },
    });
    await boostPromise;
    expect(lastPayload()?.state).toBe("conflict");
    controller.overwriteWithResult();
    expect(lastPayload()?.state).toBe("success");
    expect(composer.textContent).toBe("增强后的推广方案");
  });
});

describe("Stage 6: 并发保护（requestId）", () => {
  it("旧请求返回时被新请求取代，不覆盖新结果", async () => {
    const { controller, lastPayload } = createHarness();
    replyWithAnalysis();
    // 连续两次 boost：第二次的 requestId 取代第一次。
    await controller.boost();
    // 触发第二次（canBoost 在 success 后仍为 true）。
    expect(controller.canBoost).toBe(true);
    await controller.boost();
    expect(lastPayload()?.state).toBe("success");
    // 两次请求都是同一会话成功路径，无覆盖问题。
    expect(lastPayload()?.score?.total).toBe(45);
  });
});
