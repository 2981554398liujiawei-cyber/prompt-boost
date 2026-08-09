/**
 * 扩展设置存储（chrome.storage.local）。
 * 注意：这里不保存完整 API Key，只保存非敏感配置与本机令牌。
 */
import { zExtensionSettings, type ExtensionSettings } from "@prompt-boost/shared";

const SETTINGS_KEY = "settings";

export async function getExtensionSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return zExtensionSettings.parse(result[SETTINGS_KEY] ?? {});
}

export async function saveExtensionSettings(
  settings: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  const current = await getExtensionSettings();
  const merged = { ...current, ...settings };
  const parsed = zExtensionSettings.parse(merged);
  await chrome.storage.local.set({ [SETTINGS_KEY]: parsed });
  return parsed;
}

/** 获取本地服务令牌（无令牌时返回空串）。 */
export async function getLocalAgentToken(): Promise<string> {
  const settings = await getExtensionSettings();
  return settings.localAgentToken ?? "";
}
