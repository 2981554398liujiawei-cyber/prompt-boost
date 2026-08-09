import { act } from "react";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BoostButton } from "./BoostButton.js";

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("BoostButton Shadow DOM 菜单点击", () => {
  it("菜单内部点击不会被 document 捕获监听误判为外部点击", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const root = createRoot(shadow);
    const onMenuClose = vi.fn();
    const onChildClick = vi.fn();

    act(() => {
      root.render(
        createElement(BoostButton, {
          state: "idle",
          onBoost: vi.fn(),
          onOpenMenu: vi.fn(),
          ariaExpanded: true,
          menuOpen: true,
          menu: createElement("button", { type: "button", onClick: onChildClick }, "进入子菜单"),
          onMenuClose,
        }),
      );
    });

    const child = shadow.querySelector<HTMLButtonElement>(".pb-root > button:last-child");
    expect(child).not.toBeNull();
    act(() => {
      child?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    });

    expect(onChildClick).toHaveBeenCalledTimes(1);
    expect(onMenuClose).not.toHaveBeenCalled();
  });

  it("Shadow DOM 外部点击仍会关闭菜单", () => {
    const host = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(host, outside);
    const shadow = host.attachShadow({ mode: "open" });
    const root = createRoot(shadow);
    const onMenuClose = vi.fn();

    act(() => {
      root.render(
        createElement(BoostButton, {
          state: "idle",
          onBoost: vi.fn(),
          onOpenMenu: vi.fn(),
          ariaExpanded: true,
          menuOpen: true,
          menu: createElement("div", null, "菜单"),
          onMenuClose,
        }),
      );
    });
    act(() => outside.click());
    expect(onMenuClose).toHaveBeenCalledTimes(1);
  });
});
