/**
 * 本地认证令牌 CLI（token:show / token:rotate）。
 *
 * 安全设计：
 * - 完整令牌只在用户主动执行 token:show 时输出，直接写 stdout（不走 logger，
 *   因此不经过日志脱敏管道——这是有意为之，令牌本就应被用户看见）。
 * - 不写入任何日志文件。
 * - token:rotate 生成新令牌并持久化，旧令牌立即失效。
 */
import {
  loadOrCreateAuthToken,
  maskAuthToken,
  rotateAuthToken,
} from "../security/token.js";

const command = process.argv[2];

if (command === "show") {
  // 触发首次生成（若尚未创建），并返回完整令牌。
  const token = loadOrCreateAuthToken();
  // 敏感提示：本输出包含完整本地认证令牌，请勿分享。
  process.stdout.write(`\n[prompt-boost] 本地认证令牌（仅复制到扩展 Options 页，请勿泄露/提交）：\n${token}\n\n`);
  process.stdout.write(`脱敏形式：${maskAuthToken(token)}\n\n`);
  process.exit(0);
}

if (command === "rotate") {
  const token = rotateAuthToken();
  process.stdout.write(
    `\n[prompt-boost] 已轮换本地认证令牌（旧令牌立即失效）。\n` +
      `新令牌（仅复制到扩展 Options 页，请勿泄露/提交）：\n${token}\n\n` +
      `脱敏形式：${maskAuthToken(token)}\n` +
      `注意：轮换后需在扩展 Options 页更新令牌；Provider API Key 不受影响。\n\n`,
  );
  process.exit(0);
}

process.stderr.write(
  `用法：node dist/cli/token.js <show|rotate>\n`,
);
process.exit(1);
