/**
 * BoostHost 组件测试：Stage 7 追问面板三按钮（取消 / 使用默认假设 / 回答并增强）。
 * 使用 react-dom 直接渲染到 jsdom；不依赖 testing-library。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { BoostHost, type BoostHostProps } from "./BoostHost.js";
import type { BoostRequestSettings } from "../content/controller.js";

const SETTINGS: BoostRequestSettings = {
  taskType: "auto",
  enhanceLevel: "deep",
  clarificationMode: "smart",
  outputLanguage: "auto",
};

function makeProps(overrides?: Partial<BoostHostProps>): BoostHostProps {
  return {
    state: "clarifying",
    menuPane: null,
    settings: SETTINGS,
    taskTypeDisplay: { mode: "auto" },
    canBoost: false,
    clarifications: [
      { id: "q1", question: "推广的目标市场是？", reason: "影响策略选择", required: true },
      { id: "q2", question: "预算范围？", reason: "影响方案深度", required: false },
    ],
    onBoost: vi.fn(),
    onDismiss: vi.fn(),
    onOpenSettings: vi.fn(),
    onClarificationAnswer: vi.fn(),
    onClarificationSubmit: vi.fn(),
    onClarificationSkip: vi.fn(),
    onSetPane: vi.fn(),
    onSetSetting: vi.fn(),
    onCancelConflict: vi.fn(),
    onCopyConflict: vi.fn(),
    onOverwriteConflict: vi.fn(),
    onUndo: vi.fn(),
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

function renderHost(props: BoostHostProps): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root.render(createElement(BoostHost, props));
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("BoostHost 追问面板（Stage 7）", () => {
  it("clarifying 状态渲染追问问题与三按钮", () => {
    renderHost(makeProps());
    const text = container.textContent ?? "";
    expect(text).toContain("推广的目标市场是？");
    expect(text).toContain("预算范围？");
    expect(text).toContain("取消");
    expect(text).toContain("使用默认假设");
    expect(text).toContain("回答并增强");
  });

  it("点击「取消」触发 onDismiss", () => {
    const onDismiss = vi.fn();
    renderHost(makeProps({ onDismiss }));
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").trim() === "取消",
    );
    act(() => btn?.click());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("点击「使用默认假设」触发 onClarificationSkip", () => {
    const onClarificationSkip = vi.fn();
    renderHost(makeProps({ onClarificationSkip }));
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("使用默认假设"),
    );
    act(() => btn?.click());
    expect(onClarificationSkip).toHaveBeenCalledTimes(1);
  });

  it("点击「回答并增强」触发 onClarificationSubmit", () => {
    const onClarificationSubmit = vi.fn();
    renderHost(makeProps({ onClarificationSubmit }));
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => (b.textContent ?? "").includes("回答并增强"),
    );
    act(() => btn?.click());
    expect(onClarificationSubmit).toHaveBeenCalledTimes(1);
  });

  it("必填问题带 * 标记", () => {
    renderHost(makeProps());
    const label = Array.from(container.querySelectorAll("label")).find((l) =>
      (l.textContent ?? "").includes("推广的目标市场是？"),
    );
    expect(label?.textContent ?? "").toContain("*");
    // 非必填问题不带 *。
    const label2 = Array.from(container.querySelectorAll("label")).find((l) =>
      (l.textContent ?? "").includes("预算范围？"),
    );
    expect(label2?.textContent ?? "").not.toContain("*");
  });

  it("输入答案触发 onClarificationAnswer(id, value)", () => {
    const onClarificationAnswer = vi.fn();
    renderHost(makeProps({ onClarificationAnswer }));
    const input = container.querySelector("input");
    expect(input).not.toBeNull();
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "面向中小企业");
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onClarificationAnswer).toHaveBeenCalledWith("q1", "面向中小企业");
  });

  it("非 clarifying 状态不渲染追问面板", () => {
    renderHost(makeProps({ state: "idle", canBoost: true }));
    expect(container.textContent ?? "").not.toContain("回答并增强");
  });
});
