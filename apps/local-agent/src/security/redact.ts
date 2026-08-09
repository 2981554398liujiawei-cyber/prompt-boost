/**
 * 日志脱敏。任何输出前调用，避免 API Key / Bearer 令牌泄露。
 */
const REDACT_PATTERNS: Array<[RegExp, string]> = [
  // Bearer / Basic 凭证
  [/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]"],
  // OpenAI 风格 sk- 密钥
  [/\bsk-[A-Za-z0-9-_]{6,}/g, "sk-[REDACTED]"],
  // Anthropic 风格 sk-ant- 密钥
  [/\bsk-ant-[A-Za-z0-9-_]{6,}/g, "sk-ant-[REDACTED]"],
  // 通用长 hex 密钥（≥24 位）
  [/\b[0-9a-f]{32,}\b/gi, "[REDACTED]"],
  // 通用长 base64/urlsafe 片段（≥40 位）
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[REDACTED]"],
];

/** 替换字符串中的敏感片段。 */
export function redact(input: string): string {
  let out = input;
  for (const [pattern, replacement] of REDACT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
