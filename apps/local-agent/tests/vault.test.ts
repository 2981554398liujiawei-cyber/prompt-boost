// 路径隔离副作用必须先于任何 src 模块的静态导入执行（ESM 提升）。
import "./paths-env.js";
import { describe, expect, it } from "vitest";
import { TEST_TMP_DIR } from "./paths-env.js";

describe("vault", () => {
  it("开发模式下为加密文件模式，且能加密存取", async () => {
    const { createVault } = await import("../src/security/vault.js");
    const vault = await createVault();
    expect(vault.mode).toBe("file");
    const value = "sk-test-abcdef123456";
    await vault.setSecret("providerKey:test", value);
    expect(await vault.hasSecret("providerKey:test")).toBe(true);
    expect(await vault.getSecret("providerKey:test")).toBe(value);
    await vault.deleteSecret("providerKey:test");
    expect(await vault.getSecret("providerKey:test")).toBeNull();
  });

  it("加密文件中不出现明文", async () => {
    const { createVault } = await import("../src/security/vault.js");
    const { VAULT_FILE } = await import("../src/storage/paths.js");
    const vault = await createVault();
    await vault.setSecret("providerKey:secret-check", "sk-super-secret-value");
    expect(VAULT_FILE.startsWith(TEST_TMP_DIR)).toBe(true);
    const { readFileSync, existsSync } = await import("node:fs");
    expect(existsSync(VAULT_FILE)).toBe(true);
    const raw = readFileSync(VAULT_FILE, "utf8");
    expect(raw).not.toContain("sk-super-secret-value");
    await vault.deleteSecret("providerKey:secret-check");
  });

  it("Vault 文件损坏时拒绝读写且不静默覆盖原文件", async () => {
    const { createVault } = await import("../src/security/vault.js");
    const { VAULT_FILE } = await import("../src/storage/paths.js");
    const { readFileSync, writeFileSync } = await import("node:fs");
    const vault = await createVault();
    await vault.setSecret("providerKey:corruption-check", "sk-must-survive");
    const validEncryptedFile = readFileSync(VAULT_FILE, "utf8");
    const corruptedFile = "{ definitely-not-valid-json";
    writeFileSync(VAULT_FILE, corruptedFile, "utf8");

    try {
      await expect(vault.getSecret("providerKey:corruption-check")).rejects.toThrow(
        "Vault 文件损坏",
      );
      await expect(
        vault.setSecret("providerKey:new-value", "must-not-overwrite"),
      ).rejects.toThrow("Vault 文件损坏");
      expect(readFileSync(VAULT_FILE, "utf8")).toBe(corruptedFile);
    } finally {
      writeFileSync(VAULT_FILE, validEncryptedFile, "utf8");
    }

    expect(await vault.getSecret("providerKey:corruption-check")).toBe("sk-must-survive");
    await vault.deleteSecret("providerKey:corruption-check");
  });
});
