import type { ExtensionSettings } from "@prompt-boost/shared";
import type { BoostRequestSettings } from "./controller.js";

/**
 * 将内容脚本菜单使用的字段名映射到 chrome.storage 中的默认设置字段名。
 * 两套命名不能直接展开合并，否则会把旧默认值重新写回存储。
 */
export function mapBoostSettingsPatch(
  patch: Partial<BoostRequestSettings>,
): Partial<ExtensionSettings> {
  const mapped: Partial<ExtensionSettings> = {};

  if (patch.taskType !== undefined) {
    mapped.defaultTaskType = patch.taskType as ExtensionSettings["defaultTaskType"];
  }
  if (patch.enhanceLevel !== undefined) {
    mapped.defaultEnhanceLevel = patch.enhanceLevel as ExtensionSettings["defaultEnhanceLevel"];
  }
  if (patch.clarificationMode !== undefined) {
    mapped.defaultClarificationMode =
      patch.clarificationMode as ExtensionSettings["defaultClarificationMode"];
  }
  if (patch.outputLanguage !== undefined) {
    mapped.outputLanguage = patch.outputLanguage;
  }

  return mapped;
}
