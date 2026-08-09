/**
 * 文本规范化（Input Normalizer 的纯函数部分）。
 * 去空白、保留原始语言、检查长度。
 */
import { MAX_INPUT_LENGTH, MIN_INPUT_LENGTH } from "@prompt-boost/shared";

export interface NormalizeResult {
  text: string;
  isValid: boolean;
  reason?: "empty" | "too-long";
}

/** 去除无意义空白：首尾空白、重复换行折叠、行首尾空白。 */
export function normalizePromptText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 校验规范化后的文本，返回是否可进入后续流程。 */
export function validatePromptText(text: string): NormalizeResult {
  const normalized = normalizePromptText(text);
  if (normalized.length === 0) {
    return { text: normalized, isValid: false, reason: "empty" };
  }
  if (normalized.length > MAX_INPUT_LENGTH) {
    return { text: normalized, isValid: false, reason: "too-long" };
  }
  if (normalized.length < MIN_INPUT_LENGTH) {
    return { text: normalized, isValid: false, reason: "empty" };
  }
  return { text: normalized, isValid: true };
}
