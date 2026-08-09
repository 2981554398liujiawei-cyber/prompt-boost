/**
 * ProviderRegistry 单测：按类型创建 / 未知类型报错 / 缓存与失效 /
 * test 未保存配置 / list 跳过禁用项。
 */
// 路径隔离副作用必须先于任何 src 模块的静态导入执行（ESM 提升）。
import "./paths-env.js";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ProviderConfig } from "@prompt-boost/shared";
import { openDatabase } from "../src/storage/db.js";
import { createVault } from "../src/security/vault.js";
import { createSettingsService } from "../src/services/settings.js";
import { createProviderRegistry } from "../src/providers/registry.js";
import { ProviderError } from "../src/providers/types.js";

function startServer(): Promise<{ server: Server; base: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr) {
        resolve({ server, base: `http://127.0.0.1:${addr.port}` });
      }
    });
  });
}

const servers: Server[] = [];
afterAll(() => {
  for (const s of servers) s.close();
});

describe("ProviderRegistry", () => {
  let registry: ReturnType<typeof createProviderRegistry>;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "pb-registry-"));
    db = openDatabase(join(dir, "test.db"));
    const vault = await createVault();
    const settings = createSettingsService(db, vault);
    registry = createProviderRegistry(settings, vault);
  });

  it("未知类型创建时报错（不静默降级）", async () => {
    const unknownConfig = {
      id: "x",
      name: "x",
      type: "some-unknown",
      model: "m",
      timeoutSeconds: 30,
      enabled: true,
    } as unknown as ProviderConfig;
    await expect(registry.test(unknownConfig, "k")).rejects.toThrow(ProviderError);
  });

  it("get 返回 null 当 Provider 不存在", async () => {
    expect(await registry.get("nope")).toBeNull();
  });

  it("getOrThrow 对缺失 Provider 抛 MODEL_NOT_FOUND", async () => {
    await expect(registry.getOrThrow("nope")).rejects.toMatchObject({
      code: "MODEL_NOT_FOUND",
    });
  });

  it("test 用未保存配置可创建 Provider（不要求先入库）", async () => {
    const { server, base } = await startServer();
    servers.push(server);
    const provider = await registry.test(
      {
        id: "tmp",
        name: "tmp",
        type: "openai",
        baseUrl: base,
        model: "gpt-4o-mini",
        timeoutSeconds: 5,
        enabled: true,
      },
      "sk-tmp",
    );
    expect(provider.type).toBe("openai");
    const r = await provider.testConnection();
    expect(r.success).toBe(true);
  });

  it("list 跳过禁用项", async () => {
    const { server, base } = await startServer();
    servers.push(server);
    const config: ProviderConfig = {
      id: "disabled",
      name: "disabled",
      type: "openai",
      baseUrl: base,
      model: "gpt-4o-mini",
      timeoutSeconds: 5,
      enabled: false,
    };
    await db.upsertProvider(config);
    const providers = await registry.list();
    expect(providers).toHaveLength(0);
  });
});
