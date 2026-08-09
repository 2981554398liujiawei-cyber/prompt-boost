/**
 * SecondaryMenu 组件测试（Stage 6）。
 * 使用 react-dom 直接渲染到 jsdom；不依赖 testing-library。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { SecondaryMenu, type SecondaryMenuProps } from "./SecondaryMenu.js";
import type { BoostRequestSettings } from "../content/controller.js";

const SETTINGS: BoostRequestSettings = {
  taskType: "auto",
  enhanceLevel: "deep",
  clarificationMode: "smart",
  outputLanguage: "auto",
};

function makeProps(overrides?: Partial<SecondaryMenuProps>): SecondaryMenuProps {
  return {
    pane: "root",
    settings: SETTINGS,
    score: undefined,
    scoreStale: false,
    taskTypeDisplay: { mode: "auto" },
    detectedTaskType: undefined,
    onSetPane: vi.fn(),
    onSetSetting: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderMenu(props: SecondaryMenuProps): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(SecondaryMenu, props));
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("SecondaryMenu 结构", () => {
  it("pane=null 时不渲染", () => {
    renderMenu(makeProps({ pane: null }));
    expect(container.querySelector(".pb-menu")).toBeNull();
  });

  it("根菜单包含四组 + API 设置", () => {
    renderMenu(makeProps({ pane: "root" }));
    const buttons = Array.from(container.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(buttons.join("|")).toContain("增强模式");
    expect(buttons.join("|")).toContain("任务类型");
    expect(buttons.join("|")).toContain("自动追问");
    expect(buttons.join("|")).toContain("Prompt 评分");
    expect(buttons.join("|")).toContain("API 设置");
  });

  it("评分未有时显示「增强后查看」", () => {
    renderMenu(makeProps({ pane: "root" }));
    const text = container.textContent ?? "";
    expect(text).toContain("增强后查看");
  });

  it("评分有值时显示 total/100", () => {
    renderMenu(
      makeProps({
        pane: "root",
        score: {
          total: 64,
          missing: [],
          suggestions: [],
          dimensions: {},
          scoreSource: "llm",
          scoredOriginalText: "x",
        },
      }),
    );
    expect(container.textContent ?? "").toContain("64/100");
  });

  it("评分过期时显示「已过期」", () => {
    renderMenu(
      makeProps({
        pane: "root",
        score: {
          total: 64,
          missing: [],
          suggestions: [],
          dimensions: {},
          scoreSource: "llm",
          scoredOriginalText: "x",
        },
        scoreStale: true,
      }),
    );
    expect(container.textContent ?? "").toContain("已过期");
  });

  it("auto + detected 显示「自动 · 商业」", () => {
    renderMenu(
      makeProps({
        pane: "root",
        taskTypeDisplay: { mode: "auto", detected: "business" },
      }),
    );
    expect(container.textContent ?? "").toContain("自动 · 商业");
  });
});

describe("SecondaryMenu 子面板", () => {
  it("增强模式面板：quick/deep/expert 单选", () => {
    renderMenu(makeProps({ pane: "enhanceLevel" }));
    const text = container.textContent ?? "";
    expect(text).toContain("快速");
    expect(text).toContain("深度");
    expect(text).toContain("专家");
    expect(text).toContain("轻量整理，尽量保持原文");
  });

  it("点击增强模式选项触发 onSetSetting", () => {
    const onSetSetting = vi.fn();
    renderMenu(makeProps({ pane: "enhanceLevel", onSetSetting }));
    const expert = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("专家"),
    );
    act(() => expert?.click());
    expect(onSetSetting).toHaveBeenCalledWith("enhanceLevel", "expert");
  });

  it("任务类型面板包含 auto + 10 类", () => {
    renderMenu(makeProps({ pane: "taskType" }));
    const text = container.textContent ?? "";
    for (const label of ["自动识别", "写作", "编程", "商业", "分析", "研究", "学习", "翻译", "规划", "创意", "通用"]) {
      expect(text).toContain(label);
    }
  });

  it("追问面板：关闭/智能/总是", () => {
    renderMenu(makeProps({ pane: "clarification" }));
    const text = container.textContent ?? "";
    expect(text).toContain("关闭");
    expect(text).toContain("智能");
    expect(text).toContain("总是");
  });

  it("评分面板：8 维 + 建议 + 来源文案", () => {
    renderMenu(
      makeProps({
        pane: "score",
        score: {
          total: 64,
          missing: ["目标用户", "时间周期"],
          suggestions: ["补充背景"],
          dimensions: {
            objective: 80, context: 40, audience: 20, outputFormat: 60,
            constraints: 30, role: 50, materials: 10, actionability: 70,
          },
          scoreSource: "llm",
          scoredOriginalText: "x",
        },
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("64");
    expect(text).toContain("目标明确度");
    expect(text).toContain("可执行性");
    expect(text).toContain("目标用户");
    expect(text).toContain("评分来源：AI 分析");
    expect(text).not.toContain("heuristic_fallback");
  });

  it("评分面板 fallback 显示「本地估算」", () => {
    renderMenu(
      makeProps({
        pane: "score",
        score: {
          total: 30,
          missing: [],
          suggestions: [],
          dimensions: {},
          scoreSource: "heuristic_fallback",
          scoredOriginalText: "x",
        },
      }),
    );
    expect(container.textContent ?? "").toContain("评分来源：本地估算");
  });

  it("评分过期面板显示说明文字", () => {
    renderMenu(makeProps({ pane: "score", scoreStale: true }));
    const text = container.textContent ?? "";
    expect(text).toContain("当前评分来自上一次 Boost 前的 Prompt");
    expect(text).toContain("再次 Boost 后会更新");
  });

  it("评分过期面板提供「重新评分」按钮并触发 onRequestScore（修复 M）", () => {
    const onRequestScore = vi.fn();
    renderMenu(makeProps({ pane: "score", scoreStale: true, onRequestScore }));
    const rescore = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("重新评分"),
    );
    expect(rescore).toBeDefined();
    act(() => rescore?.click());
    expect(onRequestScore).toHaveBeenCalledTimes(1);
  });

  it("未接线 onRequestScore 时 stale 面板不渲染「重新评分」按钮", () => {
    renderMenu(makeProps({ pane: "score", scoreStale: true }));
    const rescore = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("重新评分"),
    );
    expect(rescore).toBeUndefined();
  });

  it("非 stale 评分面板不渲染「重新评分」按钮", () => {
    renderMenu(
      makeProps({
        pane: "score",
        scoreStale: false,
        score: {
          total: 64,
          missing: [],
          suggestions: [],
          dimensions: {},
          scoreSource: "llm",
          scoredOriginalText: "x",
        },
      }),
    );
    const rescore = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("重新评分"),
    );
    expect(rescore).toBeUndefined();
  });
});

describe("SecondaryMenu 键盘与返回", () => {
  it("返回按钮触发 onSetPane(root)", () => {
    const onSetPane = vi.fn();
    renderMenu(makeProps({ pane: "enhanceLevel", onSetPane }));
    const back = Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("返回"));
    act(() => back?.click());
    expect(onSetPane).toHaveBeenCalledWith("root");
  });

  it("root 下点击 API 设置触发 onOpenSettings", () => {
    const onOpenSettings = vi.fn();
    renderMenu(makeProps({ pane: "root", onOpenSettings }));
    const api = Array.from(container.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes("API 设置"));
    act(() => api?.click());
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("菜单项使用 role=menuitem 与 aria-checked", () => {
    renderMenu(makeProps({ pane: "taskType" }));
    const auto = Array.from(container.querySelectorAll('button[role="menuitemradio"]')).find(
      (b) => (b.textContent ?? "").includes("自动识别"),
    );
    expect(auto?.getAttribute("aria-checked")).toBe("true");
  });
});
