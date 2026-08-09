# Prompt Boost — ChatGPT DOM Adapter

> 版本 0.1.0 · MVP

## 1. 目标

把「在 ChatGPT 页面找到输入框并读写」这件事隔离在 `apps/extension/src/platform/chatgpt/` 内部。其余模块只依赖 `PlatformAdapter` 接口。

```ts
interface PlatformAdapter {
  platform: "chatgpt";
  findComposer(): HTMLElement | null;
  readInput(): string;
  writeInput(value: string): void;
  observe(callback: () => void): () => void;
}
```

## 2. 输入框发现策略

发现过程按 **优先级** 逐级尝试，避免依赖单个易变的 class：

1. `#prompt-textarea`（ID 锚点，长期稳定；对应 contenteditable 版本）。
2. `[contenteditable="true"][data-testid]` 中 role 为 `textbox` 的编辑器容器。
3. `[data-testid="send-button"]` 的**前一个兄弟**（位置锚点，作为备用）。
4. 兜底：查找 `form` 内最后一个 `contenteditable` 或 `textarea` 且不处于 disabled 状态者。

每一步都通过 `isComposerCandidate()` 复核：

- 元素是 `textarea`，或 `contenteditable` 且非 `contenteditable="false"`；
- 处于视口可见（`offsetParent` 或 bounding rect 非零）；
- `aria-hidden` 不为 `true`。

## 3. 读写语义

- `readInput()`：textarea 读 `value`；contenteditable 读 `innerText`（保留换行），并 trim 尾部空白。
- `writeInput(value)`：textarea 直接赋 `value`；contenteditable 先聚焦，清空节点后再按文本行创建 `textNode`/`<br>`，以保留用户可见的换行。
- 写回后依次派发 `input` → `change`（`InputEvent` bubbles），触发 ChatGPT 的 React 受控组件状态更新，使发送按钮正确启用。
- 写回后光标置于末尾并聚焦。

> 注释：派发事件必须与用户真实输入同源（`InputEvent`），否则 ChatGPT 的受控组件可能拒绝更新。

## 4. MutationObserver 策略

- 挂载器使用单个 `MutationObserver` 监听 `document.body` 的子树变化（childList + subtree，不监听 characterData，避免高频回调）。
- 事件触发后 **debounce ~150ms**，再重新定位 composer 与按钮锚点。
- 只有当元素不存在或按钮未挂载时才执行挂载，防止重复插入。

## 5. 失败降级

| 情况 | 行为 |
| --- | --- |
| composer 未找到 | 不注入按钮；后台每 800ms 重试，最多 10 次后停止并保持空态 |
| 锚点位置变化 | 基于 send-button 位置锚点重新定位，若锚点消失则隐藏按钮 |
| 页面跳转 / SPA 路由 | history 变化 + MutationObserver 双通道触发重挂载 |
| 深色模式 | UI 使用 `color-scheme: light dark` + 语义变量，随页面变化 |

## 6. DOM 变化后的维护方式

适配器是**唯一**允许做 ChatGPT DOM 查询的模块。维护流程：

1. 修改 `chatgpt/adapter.ts` 的选择器常量与 `findComposer()`。
2. 在 `docs/DOM-ADAPTER.md` 更新选择器优先级说明。
3. 运行 `pnpm typecheck && pnpm test`（Playwright fixture 用例，后续阶段）。

> 若 ChatGPT 改版导致所有选择器失效：保持按钮隐藏、打印一次 `console.debug`，并在 README「已知限制」登记，等待适配器更新。
