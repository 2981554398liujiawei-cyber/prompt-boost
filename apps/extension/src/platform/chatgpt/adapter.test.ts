/**
 * ChatGPT 适配器测试（jsdom）。
 * 覆盖 textarea / contenteditable 的发现、读写、事件派发、重挂载幂等。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { chatgptAdapter } from "./adapter.js";

function makeTextareaComposer(): HTMLTextAreaElement {
  const form = document.createElement("form");
  const send = document.createElement("button");
  send.dataset.testid = "send-button";
  const ta = document.createElement("textarea");
  ta.id = "prompt-textarea";
  form.append(ta, send);
  document.body.append(form);
  return ta;
}

function makeContentEditableComposer(): HTMLElement {
  const form = document.createElement("form");
  const send = document.createElement("button");
  send.dataset.testid = "send-button";
  const editor = document.createElement("div");
  // jsdom 不通过属性反射 contentEditable 属性，需显式设置属性以匹配选择器。
  editor.setAttribute("contenteditable", "true");
  editor.dataset.testid = "chatgpt-input";
  form.append(editor, send);
  document.body.append(form);
  return editor;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("chatgptAdapter.findComposer", () => {
  it("通过 ID 定位 textarea", () => {
    const ta = makeTextareaComposer();
    expect(chatgptAdapter.findComposer()).toBe(ta);
  });

  it("通过语义属性定位 contenteditable", () => {
    const editor = makeContentEditableComposer();
    expect(chatgptAdapter.findComposer()).toBe(editor);
  });

  it("通过 send-button 位置锚点兜底", () => {
    const form = document.createElement("form");
    const send = document.createElement("button");
    send.dataset.testid = "send-button";
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    form.append(editor, send);
    document.body.append(form);
    expect(chatgptAdapter.findComposer()).toBe(editor);
  });

  it("无输入框时返回 null", () => {
    expect(chatgptAdapter.findComposer()).toBeNull();
  });

  it("忽略 contenteditable=false", () => {
    const form = document.createElement("form");
    const send = document.createElement("button");
    send.dataset.testid = "send-button";
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "false");
    editor.id = "prompt-textarea";
    form.append(editor, send);
    document.body.append(form);
    expect(chatgptAdapter.findComposer()).toBeNull();
  });
});

describe("chatgptAdapter 降级策略（fallback 级联）", () => {
  // jsdom 不做布局：getBoundingClientRect 恒为 0。为第 4 级（isVisible）
  // 的可见性判定 mock 出非零尺寸，否则所有候选都会被当成隐藏。
  function makeVisible(el: Element): void {
    el.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 100, height: 40, top: 0, right: 100, bottom: 40, left: 0, toJSON: () => ({}) }) as DOMRect;
  }

  it("第 3 级：send-button 位置锚点（composer 嵌套在容器内）", () => {
    const form = document.createElement("form");
    const send = document.createElement("button");
    send.dataset.testid = "send-button";
    const wrapper = document.createElement("div");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    wrapper.append(editor);
    form.append(wrapper, send);
    document.body.append(form);
    // 无 ID、无语义属性 → 通过 send-button 前一兄弟容器找到内嵌 composer。
    expect(chatgptAdapter.findComposer()).toBe(editor);
  });

  it("第 4 级：form 内最后一个可编辑元素兜底", () => {
    const form = document.createElement("form");
    const ta = document.createElement("textarea");
    ta.value = "x";
    makeVisible(ta);
    const hidden = document.createElement("textarea");
    hidden.disabled = true;
    form.append(ta, hidden);
    document.body.append(form);
    expect(chatgptAdapter.findComposer()).toBe(ta);
  });

  it("第 4 级：form 内 contenteditable 兜底（无 ID / 无语义属性 / 无 send-button）", () => {
    const form = document.createElement("form");
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    makeVisible(editor);
    form.append(editor);
    document.body.append(form);
    expect(chatgptAdapter.findComposer()).toBe(editor);
  });

  it("第 4 级：跳过隐藏（display:none 零尺寸）的编辑器", () => {
    const form = document.createElement("form");
    const hidden = document.createElement("div");
    hidden.setAttribute("contenteditable", "true");
    hidden.style.display = "none";
    const visible = document.createElement("div");
    visible.setAttribute("contenteditable", "true");
    makeVisible(visible);
    form.append(hidden, visible);
    document.body.append(form);
    expect(chatgptAdapter.findComposer()).toBe(visible);
  });

  it("第 4 级：跳过 aria-hidden 的编辑器", () => {
    const form = document.createElement("form");
    const hidden = document.createElement("div");
    hidden.setAttribute("contenteditable", "true");
    hidden.setAttribute("aria-hidden", "true");
    const visible = document.createElement("div");
    visible.setAttribute("contenteditable", "true");
    makeVisible(visible);
    form.append(hidden, visible);
    document.body.append(form);
    expect(chatgptAdapter.findComposer()).toBe(visible);
  });

  it("级联优先级：ID 锚点 > 语义属性 > send-button 位置 > form 兜底", () => {
    const form = document.createElement("form");
    // 第 4 级候选：form 内 contenteditable。
    const fallback = document.createElement("div");
    fallback.setAttribute("contenteditable", "true");
    fallback.textContent = "fallback";
    makeVisible(fallback);
    // 第 3 级候选：send-button 前一兄弟。
    const send = document.createElement("button");
    send.dataset.testid = "send-button";
    const anchorEditor = document.createElement("div");
    anchorEditor.setAttribute("contenteditable", "true");
    anchorEditor.textContent = "anchor";
    // 第 2 级候选：语义属性。
    const semantic = document.createElement("div");
    semantic.setAttribute("contenteditable", "true");
    semantic.dataset.testid = "chatgpt-input";
    semantic.textContent = "semantic";
    // 第 1 级候选：ID。
    const idEditor = document.createElement("textarea");
    idEditor.id = "prompt-textarea";
    idEditor.value = "id";
    form.append(idEditor, semantic, anchorEditor, send, fallback);
    document.body.append(form);
    expect(chatgptAdapter.findComposer()).toBe(idEditor);
  });

  it("级联降级：ID 失效（contenteditable=false）时回退到语义属性", () => {
    const form = document.createElement("form");
    const broken = document.createElement("textarea");
    broken.id = "prompt-textarea";
    broken.disabled = true;
    const semantic = document.createElement("div");
    semantic.setAttribute("contenteditable", "true");
    semantic.dataset.testid = "prompt-editor";
    form.append(broken, semantic);
    document.body.append(form);
    expect(chatgptAdapter.findComposer()).toBe(semantic);
  });

  it("级联降级：无语义属性时回退到 send-button 位置锚点", () => {
    const form = document.createElement("form");
    const send = document.createElement("button");
    send.dataset.testid = "send-button";
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    form.append(editor, send);
    document.body.append(form);
    // 无 ID、无语义属性 → send-button 前一兄弟。
    expect(chatgptAdapter.findComposer()).toBe(editor);
  });
});

describe("chatgptAdapter.readInput / writeInput", () => {
  it("textarea 读取与写入", () => {
    const ta = makeTextareaComposer();
    ta.value = "第一行\n第二行";
    expect(chatgptAdapter.readInput()).toBe("第一行\n第二行");
    chatgptAdapter.writeInput("新内容\n多行");
    expect(ta.value).toBe("新内容\n多行");
  });

  it("写入 textarea 触发 input/change 事件", () => {
    const ta = makeTextareaComposer();
    const events: string[] = [];
    ta.addEventListener("input", () => events.push("input"));
    ta.addEventListener("change", () => events.push("change"));
    chatgptAdapter.writeInput("hello");
    expect(events).toContain("input");
    expect(events).toContain("change");
  });

  it("contenteditable 写入保留换行并触发事件", () => {
    const editor = makeContentEditableComposer();
    editor.textContent = "旧内容";
    const events: string[] = [];
    editor.addEventListener("input", () => events.push("input"));
    chatgptAdapter.writeInput("第一行\n第二行");
    // jsdom 不实现 innerText，通过 readInput 往返校验换行保留。
    expect(chatgptAdapter.readInput()).toBe("第一行\n第二行");
    expect(events).toContain("input");
  });

  it("contenteditable 读回时按 <br> 还原换行", () => {
    const editor = makeContentEditableComposer();
    editor.innerHTML = "第一行<br>第二行";
    expect(chatgptAdapter.readInput()).toBe("第一行\n第二行");
  });
});

describe("chatgptAdapter.observe", () => {
  it("返回取消订阅函数", () => {
    const unsub = chatgptAdapter.observe(() => {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("DOM 变化触发回调（childList）", () => {
    let calls = 0;
    const unsub = chatgptAdapter.observe(() => {
      calls += 1;
    });
    const div = document.createElement("div");
    document.body.append(div);
    // MutationObserver 异步触发，等待微任务。
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(calls).toBeGreaterThan(0);
        unsub();
        resolve();
      }, 20);
    });
  });
});
