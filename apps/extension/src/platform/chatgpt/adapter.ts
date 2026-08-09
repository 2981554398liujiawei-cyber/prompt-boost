import type { PlatformAdapter } from "../types.js";

/** 定位文本块时所需的标签，保留原始大写的匹配。 */
const COMPOSER_IDS = ["#prompt-textarea", "#prompt-input"] as const;
const COMPOSER_SELECTORS = [
  '[contenteditable="true"][data-testid="chatgpt-input"]',
  '[contenteditable="true"][data-testid="prompt-editor"]',
] as const;
const SEND_BUTTON_SELECTOR = '[data-testid="send-button"]';
/** 兜底：优先在 form 内查找可编辑元素。 */
const FORM_COMPOSER_SELECTOR = "form textarea, form [contenteditable]";

/** 判断元素是否是一个可用的 composer。 */
function isComposerCandidate(el: Element): el is HTMLElement {
  if (el instanceof HTMLTextAreaElement) {
    return !el.disabled && !el.hidden && !el.getAttribute("aria-hidden");
  }
  if (el instanceof HTMLElement) {
    // contenteditable 判断优先读属性：jsdom 不实现 isContentEditable，
    // 直接查属性在真实 DOM 与测试环境中都稳定。
    const ce = el.getAttribute("contenteditable");
    if (ce === "true" || el.isContentEditable === true) {
      if (el.getAttribute("aria-hidden") === "true") return false;
      return true;
    }
  }
  return false;
}

/** 判断元素是否在视口可见（兜底：排除 display:none 或零尺寸）。 */
function isVisible(el: HTMLElement): boolean {
  if (el.offsetParent !== null) return true;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** 按优先级顺序查找 composer，找不到返回 null。 */
function findComposerInDom(root: Document | HTMLElement): HTMLElement | null {
  // 1) ID 锚点（长期稳定）。
  for (const id of COMPOSER_IDS) {
    const el = root.querySelector<HTMLElement>(id);
    if (el && isComposerCandidate(el)) return el;
  }
  // 2) 语义属性 + contenteditable。
  for (const selector of COMPOSER_SELECTORS) {
    const el = root.querySelector<HTMLElement>(selector);
    if (el && isComposerCandidate(el)) return el;
  }
  // 3) 位置锚点：send-button 的前一个兄弟。
  const sendBtn = root.querySelector<HTMLElement>(SEND_BUTTON_SELECTOR);
  if (sendBtn?.previousElementSibling) {
    const prev = sendBtn.previousElementSibling;
    const candidate = findComposerInContainer(prev);
    if (candidate) return candidate;
  }
  // 4) 兜底：form 内最后一个可编辑元素。
  const formEls = Array.from(root.querySelectorAll<HTMLElement>(FORM_COMPOSER_SELECTOR));
  for (let i = formEls.length - 1; i >= 0; i--) {
    const el = formEls[i];
    if (isComposerCandidate(el) && isVisible(el)) return el;
  }
  return null;
}

/** 在 send-button 相邻容器内找 composer（限制范围，避免误判）。 */
function findComposerInContainer(container: Element): HTMLElement | null {
  if (isComposerCandidate(container)) return container;
  const inner = container.querySelector<HTMLElement>(
    `textarea, [contenteditable], ${COMPOSER_SELECTORS.join(", ")}`,
  );
  return inner && isComposerCandidate(inner) ? inner : null;
}

/** 发送按钮（用于定位）。 */
function findSendButton(root: Document): HTMLElement | null {
  return root.querySelector<HTMLElement>(SEND_BUTTON_SELECTOR);
}

/**
 * 将 contenteditable 的内容转换为带换行的文本。
 * <br> 与块级元素（p/div/li 等）视为换行；连续换行折叠为最多 2 个。
 */
function textFromContentEditable(root: HTMLElement): string {
  let text = "";
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.tagName === "BR") {
      text += "\n";
      return;
    }
    for (const child of el.childNodes) walk(child);
    if (el.tagName === "P" || el.tagName === "DIV" || el.tagName === "LI") {
      text += "\n";
    }
  };
  for (const child of root.childNodes) walk(child);
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * ChatGPT 平台适配器。
 * 所有对 ChatGPT DOM 的查询都集中在此文件；页面改版时只需更新这里。
 */
export const chatgptAdapter: PlatformAdapter = {
  platform: "chatgpt",
  findComposer() {
    return findComposerInDom(document);
  },
  readInput() {
    const composer = findComposerInDom(document);
    if (!composer) return "";
    if (composer instanceof HTMLTextAreaElement) {
      return composer.value;
    }
    // contenteditable：优先 innerText（保留可见换行）。
    // jsdom 不实现 innerText；回退到基于子节点的等价转换（<br>/块级 → 换行）。
    const innerText = composer.innerText;
    if (innerText != null) {
      return innerText.replace(/\n{3,}$/, "\n").replace(/\n$/, "");
    }
    return textFromContentEditable(composer)
      .replace(/\n{3,}$/, "\n")
      .replace(/\n$/, "");
  },
  writeInput(value: string) {
    const composer = findComposerInDom(document);
    if (!composer) return;
    if (composer instanceof HTMLTextAreaElement) {
      composer.value = value;
    } else {
      // 先聚焦，清空旧内容，再按行写入，以保留换行。
      composer.focus();
      composer.textContent = "";
      const lines = value.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) composer.append(document.createElement("br"));
        composer.append(document.createTextNode(lines[i]));
      }
    }
    // 触发 React 受控组件更新：input + change。
    composer.dispatchEvent(
      new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }),
    );
    composer.dispatchEvent(
      new InputEvent("change", { bubbles: true, data: value }),
    );
    composer.focus();
    // 光标移到末尾。
    try {
      const sel = window.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(composer);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } catch {
      // 忽略光标定位失败。
    }
  },
  observe(callback: () => void) {
    // 双通道：MutationObserver 监听 DOM 变化 + history 变化监听 SPA 路由。
    const observer = new MutationObserver(() => callback());
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
    const onRoute = (): void => callback();
    window.addEventListener("popstate", onRoute);
    // 拦截 pushState/replaceState 的朴素版本：通过包装触发。
    const originalPush = history.pushState.bind(history);
    const originalReplace = history.replaceState.bind(history);
    history.pushState = ((...args: Parameters<typeof originalPush>) => {
      const result = originalPush(...args);
      callback();
      return result;
    }) as typeof history.pushState;
    history.replaceState = ((...args: Parameters<typeof originalReplace>) => {
      const result = originalReplace(...args);
      callback();
      return result;
    }) as typeof history.replaceState;

    return () => {
      observer.disconnect();
      window.removeEventListener("popstate", onRoute);
      history.pushState = originalPush;
      history.replaceState = originalReplace;
    };
  },
};

/** 供调试 / 测试：暴露查找函数。 */
export { findComposerInDom, findSendButton };
