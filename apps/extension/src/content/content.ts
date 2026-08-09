/**
 * content script 入口。
 *
 * 职责：
 *  - 检测 ChatGPT 输入框。
 *  - 在输入框操作区旁注入 Boost UI（Shadow DOM，React 渲染）。
 *  - 监听 DOM 变化 / SPA 路由，自动重挂载。
 *  - 确保不会重复插入多个按钮。
 */
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { chatgptAdapter } from "../platform/chatgpt/adapter.js";
import type { PlatformAdapter } from "../platform/types.js";
import { BoostHost } from "../components/BoostHost.js";
import { boostStyles } from "../styles/boost.css.js";
import { BoostController, type BoostUiPayload } from "./controller.js";
import { getExtensionSettings, saveExtensionSettings } from "../background/settings.js";

const BOOST_ROOT_ID = "prompt-boost-root";

// ── Shadow DOM 挂载 ──────────────────────────────────────
interface MountedUI {
  host: HTMLElement;
  root: Root;
  destroy(): void;
}

function attachShadowHost(): MountedUI {
  const host = document.createElement("div");
  host.id = BOOST_ROOT_ID;
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = boostStyles;
  shadow.appendChild(style);

  const mountPoint = document.createElement("div");
  mountPoint.className = "pb-mount";
  shadow.appendChild(mountPoint);

  // 根据页面主题切换 host 的 data-theme 属性（深色/浅色）。
  const applyTheme = (): void => {
    const isDark =
      document.documentElement.classList.contains("dark") ||
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    host.dataset.theme = isDark ? "dark" : "light";
  };
  applyTheme();

  const root = createRoot(mountPoint);
  return {
    host,
    root,
    destroy() {
      root.unmount();
      host.remove();
    },
  };
}

// ── 注入逻辑 ────────────────────────────────────────────
function bootstrap(): void {
  if (window.__promptBoostInstalled) {
    // 已安装：保持现有挂载，避免重复插入。
    return;
  }
  window.__promptBoostInstalled = true;

  const adapter: PlatformAdapter = chatgptAdapter;
  let ui: MountedUI | null = null;
  let mountedAtComposer: HTMLElement | null = null;
  let controller: BoostController | null = null;

  const makeController = (): BoostController =>
    new BoostController({
      adapter,
      getBoostSettings: async () => {
        const s = await getExtensionSettings();
        return {
          taskType: s.defaultTaskType,
          enhanceLevel: s.defaultEnhanceLevel,
          clarificationMode: s.defaultClarificationMode,
          outputLanguage: s.outputLanguage,
        };
      },
      saveSettings: async (patch) => {
        const s = await getExtensionSettings();
        const merged = { ...s, ...patch };
        await saveExtensionSettings({
          defaultTaskType: merged.defaultTaskType,
          defaultEnhanceLevel: merged.defaultEnhanceLevel,
          defaultClarificationMode: merged.defaultClarificationMode,
        });
      },
      onOpenSettings: () => {
        void chrome.runtime.openOptionsPage();
      },
      onState: (state, payload: BoostUiPayload) => {
        render(state, payload);
      },
    });

  const render = (state: string, payload: BoostUiPayload): void => {
    if (!ui || !controller) return;
    ui.root.render(
      createElement(BoostHost, {
        state: state as never,
        errorMessage: payload.errorMessage,
        score: payload.score,
        scoreStale: payload.scoreStale,
        clarifications: payload.clarifications,
        clarificationAnswers: payload.clarificationAnswers,
        lastBoostResult: payload.lastBoostResult,
        conflictEnhancedText: payload.conflictEnhancedText,
        menuPane: payload.menuPane,
        settings: payload.settings,
        taskTypeDisplay: payload.taskTypeDisplay,
        detectedTaskType: payload.detectedTaskType,
        canBoost: controller.canBoost,
        onBoost: () => {
          void controller?.boost();
        },
        onDismiss: () => controller?.dismiss(),
        onOpenSettings: () => {
          void chrome.runtime.openOptionsPage();
        },
        onClarificationAnswer: (id, value) => controller?.setClarificationAnswer(id, value),
        onClarificationSubmit: () => {
          void controller?.submitClarification();
        },
        onClarificationSkip: () => controller?.useDefaultAssumptions(),
        onSetPane: (pane) => controller?.setMenuPane(pane),
        onSetSetting: (field, value) => {
          void controller?.setSetting(field, value);
        },
        onCancelConflict: () => controller?.cancelConflict(),
        onCopyConflict: () => {
          void controller?.copyConflictResult();
        },
        onOverwriteConflict: () => controller?.overwriteWithResult(),
        onUndo: () => controller?.undo(),
        onRequestScore: () => {
          void controller?.requestScore();
        },
      }),
    );
  };

  // 定位输入框操作区旁的锚点（send-button 相邻容器）。
  const findAnchor = (): HTMLElement | null => {
    const composer = adapter.findComposer();
    if (!composer) return null;
    // 在 composer 所在容器（表单）内查找 send-button。
    const container = composer.closest("form") ?? composer.parentElement;
    if (!container) return null;
    return container.querySelector('[data-testid="send-button"]')?.parentElement ?? null;
  };

  // 挂载 / 重挂载。
  const mount = (): void => {
    const anchor = findAnchor();
    if (!anchor) return;
    if (ui && mountedAtComposer === anchor) return;
    if (ui) {
      ui.destroy();
      controller?.dispose();
      controller = null;
      ui = null;
    }
    controller = makeController();
    ui = attachShadowHost();
    anchor.prepend(ui.host);
    mountedAtComposer = anchor;
    void controller.refresh();
  };

  const tryMount = (): void => {
    if (!adapter.findComposer()) return;
    mount();
  };

  // 初始挂载：延迟等待 ChatGPT 渲染完成；失败则重试最多 10 次。
  let retries = 0;
  const initialAttempt = (): void => {
    tryMount();
    if (ui) return;
    retries += 1;
    if (retries < 10) {
      window.setTimeout(initialAttempt, 800);
    } else {
      console.debug("[prompt-boost] 未检测到 ChatGPT 输入框，停止重试。");
    }
  };
  window.setTimeout(initialAttempt, 300);

  // 后续变化：debounce 后重挂载。
  let debounceTimer: number | undefined;
  adapter.observe(() => {
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      tryMount();
    }, 150);
  });
}

// ── 全局标记：防止 content script 重复执行导致重复挂载 ──
declare global {
  interface Window {
    __promptBoostInstalled?: boolean;
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
} else {
  bootstrap();
}
