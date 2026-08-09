/**
 * 平台适配器接口。所有 ChatGPT DOM 查询集中在 platform/ 下，
 * UI 与业务逻辑只依赖此接口。
 */
export interface PlatformAdapter {
  /** 平台标识。 */
  platform: "chatgpt";
  /**
   * 定位输入框。返回可读写的 composer 元素，找不到返回 null。
   * 调用方应避免缓存该引用，每次读取前重新定位。
   */
  findComposer(): HTMLElement | null;
  /** 读取输入框文本（textarea 取 value，contenteditable 取 innerText）。 */
  readInput(): string;
  /** 将文本写入输入框并触发必要的 input/change 事件。 */
  writeInput(value: string): void;
  /**
   * 订阅 composer/锚点变化（SPA 路由、重渲染、位置变化）。
   * 返回取消订阅函数。
   */
  observe(callback: () => void): () => void;
}
