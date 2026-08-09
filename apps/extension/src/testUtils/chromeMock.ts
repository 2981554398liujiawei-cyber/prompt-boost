/**
 * 测试用 chrome API mock（jsdom 环境）。
 * 类型尽量贴近 @types/chrome，便于测试直接使用。
 */
type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

export interface ChromeMock {
  runtime: {
    onMessage: { addListener: (fn: MessageListener) => void };
    sendMessage: (message: unknown) => Promise<unknown>;
    openOptionsPage: () => Promise<void>;
  };
  storage: {
    local: {
      get: (key: string) => Promise<Record<string, unknown>>;
      set: (obj: Record<string, unknown>) => Promise<void>;
    };
  };
}

export function installChromeMock(): ChromeMock {
  const listeners: MessageListener[] = [];
  const storage = new Map<string, unknown>();

  const mock: ChromeMock = {
    runtime: {
      onMessage: {
        addListener: (fn) => {
          listeners.push(fn);
        },
      },
      sendMessage: (message) => {
        return new Promise((resolve) => {
          for (const fn of listeners) {
            const keep = fn(message, {}, resolve);
            if (keep === true) return;
          }
          resolve(undefined);
        });
      },
      openOptionsPage: () => Promise.resolve(),
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage.get(key) }),
        set: async (obj) => {
          for (const [k, v] of Object.entries(obj)) storage.set(k, v);
        },
      },
    },
  };

  // 挂到 globalThis，使模块内的 chrome.runtime 可用。
  (globalThis as unknown as { chrome: ChromeMock }).chrome = mock;
  return mock;
}
