/**
 * 本地服务入口。默认监听 127.0.0.1:8787。
 *
 * 启动流程：加载环境 → 打开 SQLite → 创建 Vault → 读取/生成认证令牌
 *           → 创建 Prompt Engine → 启动 HTTP。
 *
 * 安全：普通启动日志只打印脱敏令牌（pb_****xxxx）。
 * 完整令牌通过 `pnpm token:show` 主动查看。
 */
import { loadEnv } from "./env.js";
import { openDatabase } from "./storage/db.js";
import { createVault } from "./security/vault.js";
import { loadOrCreateAuthToken, maskAuthToken } from "./security/token.js";
import { createPromptEngine } from "./prompt-engine/prompt-engine.js";
import { createApp } from "./app.js";
import { createLogger } from "./log.js";
import { EXTENSION_VERSION } from "@prompt-boost/shared";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { AUTH_TOKEN_FILE, PID_FILE } from "./storage/paths.js";
import { writePrivateFileAtomic } from "./security/private-file.js";
import { createSettingsService } from "./services/settings.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger(env.logVerbose);

  const db = openDatabase(env.dbPath);
  const vault = await createVault();
  const authToken = loadOrCreateAuthToken();
  // 启动前迁移所有 Provider（包括禁用项）的旧敏感 Header，并清理 SQLite/WAL 残留。
  await createSettingsService(db, vault).migrateAllProviderHeaders();
  const promptEngine = createPromptEngine(db, vault);

  log.info(`本地服务启动于 http://${env.host}:${env.port}`);
  log.info(`数据库：${env.dbPath}`);
  // 只显示脱敏令牌。完整令牌通过 token:show 命令主动获取。
  log.info(`Local auth token loaded: ${maskAuthToken(authToken)}`);
  log.info(
    `密钥存储模式：${vault.mode}${vault.mode === "file" ? "（开发模式，生产请启用系统凭证库）" : ""}`,
  );

  let shutdownHandler = (): void => undefined;
  const app = createApp({
    db,
    vault,
    authToken,
    version: EXTENSION_VERSION,
    logVerbose: env.logVerbose,
    promptEngine,
    logger: log,
    shutdown: () => shutdownHandler(),
  });

  let shuttingDown = false;
  let databaseClosed = false;
  const removeOwnPidFile = (): void => {
    try {
      if (!existsSync(PID_FILE)) return;
      const raw = readFileSync(PID_FILE, "utf8").trim();
      const recordedPid = raw.startsWith("{")
        ? Number((JSON.parse(raw) as { pid?: unknown }).pid)
        : Number(raw);
      if (recordedPid === process.pid) {
        unlinkSync(PID_FILE);
      }
    } catch {
      // 退出清理尽力而为；停止脚本仍会校验命令行，不会误杀其它进程。
    }
  };
  const closeDatabase = (): void => {
    if (databaseClosed) return;
    databaseClosed = true;
    db.close();
  };

  const server = app.listen(env.port, env.host, () => {
    try {
      writePrivateFileAtomic(
        PID_FILE,
        JSON.stringify({
          pid: process.pid,
          port: env.port,
          entry: process.argv[1] ?? "",
          authTokenFile: AUTH_TOKEN_FILE,
        }),
      );
    } catch (err) {
      log.error(`无法写入 PID 文件：${err instanceof Error ? err.message : String(err)}`);
      shutdown();
      return;
    }
    log.info(`运行中：http://${env.host}:${env.port}（查看完整令牌请执行 pnpm token:show）`);
  });

  // 兜底：任何请求（含 socket 悬空）最多 120s，防止慢 Provider 挂死连接常驻。
  // 正常路径不会触达：Provider 层 timeoutSeconds（packyapi=60s）先于它失败。
  server.timeout = 120_000;

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("正在关闭本地服务…");
    const deadline = setTimeout(() => {
      log.error("优雅关闭超过 10 秒，强制断开剩余连接");
      server.closeAllConnections();
      removeOwnPidFile();
      closeDatabase();
      process.exit(1);
    }, 10_000);
    deadline.unref();
    server.closeIdleConnections();
    server.close(() => {
      clearTimeout(deadline);
      removeOwnPidFile();
      closeDatabase();
      log.info("已关闭（数据库正常落盘）");
      process.exit(0);
    });
  };
  shutdownHandler = shutdown;
  server.on("error", (err) => {
    removeOwnPidFile();
    closeDatabase();
    log.error(`HTTP 服务错误：${err.message}`);
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[prompt-boost:error] 启动失败：${message}`);
  process.exit(1);
});
