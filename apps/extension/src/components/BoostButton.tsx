import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import type { ReactNode } from "react";

export type BoostButtonState = "idle" | "loading" | "success" | "error";

interface BoostButtonProps {
  state: BoostButtonState;
  disabled?: boolean;
  onBoost: () => void;
  onOpenMenu: () => void;
  ariaExpanded: boolean;
  menuOpen: boolean;
  /** 二级菜单渲染节点。 */
  menu: ReactNode;
  onMenuClose: () => void;
}

const STATE_LABELS: Record<BoostButtonState, string> = {
  idle: "✨ Boost",
  loading: "正在增强…",
  success: "已增强 ✓",
  error: "增强失败",
};

/**
 * 输入框旁的 Boost 主按钮 + ▾ 展开入口（Stage 6）。
 * - 点击 Boost 直接增强，不打开菜单。
 * - 点击 ▾ 切换二级菜单。
 * - 菜单打开时：点击外部关闭、Esc 关闭；不阻塞 ChatGPT 输入（仅浮层）。
 */
export function BoostButton({
  state,
  disabled,
  onBoost,
  onOpenMenu,
  ariaExpanded,
  menuOpen,
  menu,
  onMenuClose,
}: BoostButtonProps) {
  const wrapRef = useRef<HTMLDivElement>(null);

  const handleMenuClick = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (menuOpen) {
        onMenuClose();
      } else {
        onOpenMenu();
      }
    },
    [menuOpen, onOpenMenu, onMenuClose],
  );

  // 点击菜单外部关闭（捕获阶段，避免被 ChatGPT 的监听吞掉）。
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: globalThis.MouseEvent): void => {
      const wrap = wrapRef.current;
      if (!wrap) return;

      // 事件穿过 Shadow DOM 边界后，document 看到的 target 会被重定向为
      // shadow host，wrap.contains(target) 因而恒为 false。使用 composedPath
      // 才能识别点击实际发生在菜单内部，避免捕获阶段先关闭菜单、吞掉子菜单点击。
      const path = typeof e.composedPath === "function" ? e.composedPath() : [];
      const targetInside = e.target instanceof Node && wrap.contains(e.target);
      if (!path.includes(wrap) && !targetInside) {
        onMenuClose();
      }
    };
    document.addEventListener("click", onDocClick, true);
    return () => document.removeEventListener("click", onDocClick, true);
  }, [menuOpen, onMenuClose]);

  // Esc 关闭菜单。
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onMenuClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [menuOpen, onMenuClose]);

  return (
    <div className="pb-root" ref={wrapRef}>
      <button
        type="button"
        className="pb-boost"
        disabled={disabled || state === "loading"}
        aria-label="Prompt Boost 增强当前输入"
        title="Prompt Boost"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onBoost();
        }}
      >
        {STATE_LABELS[state]}
      </button>
      <button
        type="button"
        className="pb-trigger"
        aria-label="Prompt Boost 二级菜单"
        aria-haspopup="menu"
        aria-expanded={ariaExpanded || menuOpen}
        onClick={handleMenuClick}
      >
        ▾
      </button>
      {menuOpen && menu}
    </div>
  );
}
