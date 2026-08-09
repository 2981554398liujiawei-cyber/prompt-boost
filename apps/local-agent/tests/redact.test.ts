import { describe, expect, it } from "vitest";
import { redact } from "../src/security/redact.js";

describe("redact", () => {
  it("脱敏 Bearer 令牌", () => {
    const out = redact("Authorization: Bearer sk-abcdef123456789");
    expect(out).not.toContain("sk-abcdef123456789");
    expect(out).toContain("Bearer [REDACTED]");
  });

  it("脱敏 sk- 风格密钥", () => {
    const out = redact("key=sk-proj-9f8e7d6c5b4a");
    expect(out).not.toContain("sk-proj-9f8e7d6c5b4a");
  });

  it("脱敏长 hex 片段", () => {
    const hex = "0123456789abcdef0123456789abcdef";
    expect(redact(`token=${hex}`)).not.toContain(hex);
  });

  it("保留普通文本", () => {
    expect(redact("hello 世界")).toBe("hello 世界");
  });
});
