/**
 * 后台消息响应兜底：handler 抛错时也调用 sendResponse。
 *
 * 背景：MV3 中消息处理器返回 true 表示将异步调用 sendResponse。若 handler
 * 抛错而 sendResponse 永不调用，调用方（Options/popup/content）的
 * chrome.runtime.sendMessage Promise 会永久挂起——连接测试表现为"测试中…"卡死。
 * 统一包装确保无论成功/失败都恰好调用一次 sendResponse。
 */
export function respond<T>(
  handler: () => Promise<T>,
  sendResponse: (r: T | { error: { code: string; message: string } }) => void,
): void {
  Promise.resolve()
    .then(handler)
    .then(sendResponse)
    .catch((err: unknown) => {
      sendResponse({
        error: {
          code: "background",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    });
}
