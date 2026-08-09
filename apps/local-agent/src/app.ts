/**
 * 本地服务应用工厂。返回 Express app，便于测试注入。
 */
import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { ZodError } from "zod";
import { createSettingsService, type SettingsService } from "./services/settings.js";
import type { DbHandle } from "./storage/db.js";
import type { Vault } from "./security/vault.js";
import {
  Err,
  ApiError,
  toErrorResponse,
  zodErrorResponse,
} from "./api/errors.js";
import { zAnalyzeRequest, zEnhancePromptRequest, zProviderModelsRequest, zProviderUpdateRequest, zProviderUpsert, zProviderTestRequest, type ProviderConfig } from "@prompt-boost/shared";
import { classifyTaskType, heuristicScore } from "@prompt-boost/prompt-core";
import { createLogger, type Logger } from "./log.js";
import type { PromptEngine } from "./prompt-engine/prompt-engine.js";
import type { ProviderRegistry } from "./providers/registry.js";
import { ProviderError } from "./providers/types.js";

export interface AppDeps {
  db: DbHandle;
  vault: Vault;
  authToken: string;
  version: string;
  logVerbose?: boolean;
  /** 当前阶段的可选依赖；为 null 时对应接口返回 501。 */
  promptEngine?: PromptEngine;
  logger?: Logger;
  /** 生产入口注入的优雅关闭钩子；测试未注入时接口返回 501。 */
  shutdown?: () => void;
}

/** 解析 Bearer 令牌（未知令牌不返回 401，避免探测）。 */
function extractToken(req: Request): string {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : "";
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  const settings: SettingsService = createSettingsService(deps.db, deps.vault);
  const log = deps.logger ?? createLogger(deps.logVerbose ?? false);

  app.use(express.json({ limit: "512kb" }));
  app.use(
    cors({
      origin: (origin, callback) => {
        // 无 Origin（curl / 同进程测试）放行；浏览器请求需白名单。
        if (!origin) return callback(null, true);
        if (origin.startsWith("chrome-extension://")) return callback(null, true);
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
          return callback(null, true);
        }
        return callback(new ApiError(403, "forbidden", "Origin 不在允许列表"), false);
      },
    }),
  );

  // 请求日志（不含请求体；只记录方法、路径、状态码、耗时）。
  app.use((req, _res, next) => {
    const start = Date.now();
    const res = _res;
    res.on("finish", () => {
      log.debug(
        `${req.method} ${req.path} -> ${res.statusCode} ${Date.now() - start}ms`,
      );
    });
    next();
  });

  // ── 路由 ──────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "prompt-boost-local-agent",
      version: deps.version,
      time: Date.now(),
    });
  });

  // 其余接口全部要求认证。
  const authed = (req: Request, res: Response, next: NextFunction): void => {
    const token = extractToken(req);
    if (token !== deps.authToken) {
      res.status(401).json(Err.unauthorized().toResponse());
      return;
    }
    next();
  };
  app.use("/v1", authed);

  /** Express 4 不会自动转发 async rejection；所有异步路由统一显式交给错误中间件。 */
  const asyncRoute =
    (
      handler: (req: Request, res: Response, next: NextFunction) => void | Promise<void>,
    ) =>
    (req: Request, res: Response, next: NextFunction): void => {
      Promise.resolve(handler(req, res, next)).catch(next);
    };

  // 需要 Prompt Engine 的接口：引擎缺失时返回 501（当前不会发生，测试可注入 null）。
  // 处理器抛错时转发到统一错误中间件（不吞掉未处理 rejection）。
  const requireEngine =
    (
      handler: (req: Request, res: Response, next: NextFunction) => void | Promise<void>,
    ) =>
    (req: Request, res: Response, next: NextFunction): void => {
      if (!deps.promptEngine) {
        res.status(501).json(Err.notImplemented().toResponse());
        return;
      }
      asyncRoute(handler)(req, res, next);
    };

  // ── Provider 配置路由 ─────────────────────────────────
  // API Key 只存 Vault；所有响应都只返回 ProviderSummary（apiKeyConfigured），
  // 完整 Key 永不进入 SQLite / 响应体 / 日志。

  app.get("/v1/providers", asyncRoute(async (_req, res) => {
    const providers = await settings.listProviderSummaries();
    res.json({ providers, activeProviderId: settings.getActiveProviderId() });
  }));

  app.post("/v1/providers", asyncRoute(async (req, res) => {
    const body = zProviderUpsert.safeParse(req.body);
    if (!body.success) {
      res.status(400).json(zodErrorResponse(body.error));
      return;
    }
    await settings.saveProvider(body.data.config, body.data.apiKey);
    const provider = await settings.getProviderSummary(body.data.config.id);
    if (!provider) {
      res.status(500).json(Err.internal().toResponse());
      return;
    }
    res.status(201).json({ provider });
  }));

  app.get("/v1/providers/:id", asyncRoute(async (req, res) => {
    const provider = await settings.getProviderSummary(req.params.id);
    if (!provider) {
      res.status(404).json(Err.notFound().toResponse());
      return;
    }
    res.json({ provider });
  }));

  app.put("/v1/providers/:id", asyncRoute(async (req, res) => {
    const existing = settings.getProvider(req.params.id);
    if (!existing) {
      res.status(404).json(Err.notFound().toResponse());
      return;
    }
    const body = zProviderUpdateRequest.safeParse(req.body);
    if (!body.success) {
      res.status(400).json(zodErrorResponse(body.error));
      return;
    }
    const { apiKey, ...patch } = body.data;
    // 未提供的字段保留原值；id/createdAt 不可更新。
    const merged: ProviderConfig = {
      ...existing,
      ...patch,
      id: existing.id,
    };
    await settings.saveProvider(merged, apiKey);
    const provider = await settings.getProviderSummary(merged.id);
    res.json({ provider });
  }));

  app.delete("/v1/providers/:id", asyncRoute(async (req, res) => {
    const id = String(req.params.id);
    if (!settings.getProvider(id)) {
      res.status(404).json(Err.notFound().toResponse());
      return;
    }
    await settings.deleteProvider(id);
    // 若删除的是当前默认 Provider，同步清除，避免悬空引用。
    if (settings.getActiveProviderId() === id) {
      settings.setActiveProviderId("");
    }
    res.status(204).send();
  }));

  // POST /v1/providers/test：测试尚未保存的配置（Options 页「测试」按钮）。
  // POST /v1/providers/:id/test：测试已保存的 Provider（密钥从 Vault 读取）。
  const runTest = async (
    provider: Awaited<ReturnType<ProviderRegistry["test"]>>,
    providerId: string,
    res: Response,
  ): Promise<void> => {
    const base = {
      providerId,
      providerType: provider.type as ProviderConfig["type"],
      model: provider.config.model,
      checkedAt: new Date().toISOString(),
    };
    try {
      const result = await provider.testConnection();
      res.json(result);
    } catch (err) {
      if (err instanceof ProviderError) {
        res.json({
          ...base,
          success: false,
          latencyMs: 0,
          error: err.toSafeError(),
        });
        return;
      }
      throw err;
    }
  };

  app.post(
    "/v1/providers/test",
    requireEngine(async (req, res, next) => {
      const body = zProviderTestRequest.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(zodErrorResponse(body.error));
        return;
      }
      const resolved = await settings.resolveProviderInput(
        body.data.config,
        body.data.apiKey,
      );
      let provider: Awaited<ReturnType<ProviderRegistry["test"]>>;
      try {
        provider = await deps.promptEngine!.providers.test(
          resolved.config,
          resolved.apiKey,
        );
      } catch (err) {
        // 构造失败（如 openai-compatible 缺 Base URL）：返回统一错误结构。
        if (err instanceof ProviderError) {
          res.json({
            providerId: body.data.config.id,
            providerType: body.data.config.type,
            model: body.data.config.model,
            checkedAt: new Date().toISOString(),
            success: false,
            latencyMs: 0,
            error: err.toSafeError(),
          });
          return;
        }
        next(err);
        return;
      }
      await runTest(provider, body.data.config.id, res);
    }),
  );

  app.post(
    "/v1/providers/:id/test",
    requireEngine(async (req, res, next) => {
      const id = String(req.params.id);
      const saved = await settings.getProviderWithKey(id);
      if (!saved) {
        res.status(404).json(Err.notFound().toResponse());
        return;
      }
      const { config, apiKey } = saved;
      if (!apiKey) {
        res.json({
          providerId: id,
          providerType: config.type,
          model: config.model,
          checkedAt: new Date().toISOString(),
          success: false,
          latencyMs: 0,
          error: { code: "api_key_missing", message: "该 Provider 尚未配置 API Key" },
        });
        return;
      }
      let provider: Awaited<ReturnType<ProviderRegistry["test"]>>;
      try {
        provider = await deps.promptEngine!.providers.test(config, apiKey);
      } catch (err) {
        if (err instanceof ProviderError) {
          res.json({
            providerId: id,
            providerType: config.type,
            model: config.model,
            checkedAt: new Date().toISOString(),
            success: false,
            latencyMs: 0,
            error: err.toSafeError(),
          });
          return;
        }
        next(err);
        return;
      }
      await runTest(provider, id, res);
    }),
  );

  // POST /v1/providers/models：拉取 Provider 可用模型列表（Options 页「获取可用模型」）。
  // 请求形状与 /v1/providers/test 相同：config + 可选 apiKey。
  // - 带 apiKey（未保存配置）：直接用它。
  // - apiKey 留空且 config.id 是已保存 Provider：从 Vault 读 Key（编辑场景）。
  // - 均无 Key：返回 api_key_missing（前端明确提示）。
  // 响应只含模型 ID 数组 + providerType，绝不包含 Key。
  app.post(
    "/v1/providers/models",
    requireEngine(async (req, res, next) => {
      const body = zProviderModelsRequest.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(zodErrorResponse(body.error));
        return;
      }
      const resolved = await settings.resolveProviderInput(
        body.data.config,
        body.data.apiKey,
      );
      const { config, apiKey } = resolved;
      if (!apiKey) {
        res.json({
          providerType: config.type,
          models: [],
          error: { code: "api_key_missing", message: "该 Provider 尚未配置 API Key，请填写后重试" },
        });
        return;
      }
      let provider: Awaited<ReturnType<ProviderRegistry["test"]>>;
      try {
        provider = await deps.promptEngine!.providers.test(config, apiKey);
      } catch (err) {
        // 构造失败（如 openai-compatible 缺 Base URL）：返回统一错误结构。
        if (err instanceof ProviderError) {
          res.json({
            providerType: config.type,
            models: [],
            error: err.toSafeError(),
          });
          return;
        }
        next(err);
        return;
      }
      try {
        const models = await provider.listModels();
        res.json({ providerType: provider.type, models });
      } catch (err) {
        if (err instanceof ProviderError) {
          res.json({
            providerType: provider.type,
            models: [],
            error: err.toSafeError(),
          });
          return;
        }
        throw err;
      }
    }),
  );

  app.post("/v1/providers/:id/set-default", (req, res) => {
    const id = String(req.params.id);
    if (!settings.getProvider(id)) {
      res.status(404).json(Err.notFound().toResponse());
      return;
    }
    settings.setActiveProviderId(id);
    res.json({ ok: true, activeProviderId: id });
  });

  app.get("/v1/settings", (_req, res) => {
    res.json({ settings: settings.getSettings() });
  });

  app.put("/v1/settings", (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body !== "object") {
      res.status(400).json({ error: { code: "validation", message: "settings 必须是对象" } });
      return;
    }
    try {
      const parsed = settings.updateSettings(body);
      res.json({ ok: true, settings: parsed });
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json(zodErrorResponse(err));
        return;
      }
      throw err;
    }
  });

  app.post("/v1/system/shutdown", (_req, res) => {
    const shutdown = deps.shutdown;
    if (!shutdown) {
      res.status(501).json(Err.notImplemented().toResponse());
      return;
    }
    res.json({ ok: true });
    // 先把确认响应完整发给停止脚本，再开始关闭监听与数据库。
    res.on("finish", () => setImmediate(shutdown));
  });

  // POST /v1/enhance：一次 LLM 调用完成分类+评分+追问+增强。
  // 请求体由 shared zEnhancePromptRequest 校验；Prompt 只出现在请求体。
  // 错误统一走 ProviderError.toSafeError（不含 Key / 原始错误）。无可用
  // Provider 时返回明确错误，不静默降级。
  app.post(
    "/v1/enhance",
    requireEngine(async (req, res) => {
      const body = zEnhancePromptRequest.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(zodErrorResponse(body.error));
        return;
      }
      // 客户端断连（关闭页面/扩展中止）时中止上游 LLM 调用，避免孤儿请求
      // 继续消耗额度。
      // 注意：不能监听 req 的 "close"（Node 中表示请求体读取完成，不是断连）。
      // 用 res 的 "close"：正常完成时 res.writableEnded 已为 true（不 abort），
      // 连接中途断开时 writableEnded 为 false（abort）。
      const abort = new AbortController();
      const onClose = (): void => {
        if (!res.writableEnded) abort.abort();
      };
      res.on("close", onClose);
      const signal = abort.signal;
      try {
        const outcome = await deps.promptEngine!.enhance(body.data, signal);
        if (signal.aborted) return; // 客户端已断开，不再写响应
        res.json({
          enhancedText: outcome.enhancedText,
          analysis: outcome.analysis ?? null,
          assumptions: outcome.assumptions,
          provider: outcome.provider,
          model: outcome.model,
          fallback: outcome.fallback,
        });
      } catch (err) {
        if (signal.aborted) return; // 断连中止导致的错误，无需也不应写响应
        if (err instanceof ProviderError) {
          // 无默认 Provider → 明确的 INVALID_REQUEST；其余 Provider 错误同样安全映射。
          res.json({
            enhancedText: body.data.originalText,
            analysis: null,
            assumptions: [],
            provider: "",
            model: "",
            fallback: "passthrough",
            error: err.toSafeError(),
          });
          return;
        }
        throw err;
      } finally {
        res.off("close", onClose);
      }
    }),
  );

  // POST /v1/analyze：请求体由 shared zAnalyzeRequest 校验。
  // Prompt 只出现在请求体中，绝不进入查询参数（避免出现在 URL/日志/历史）。
  app.post(
    "/v1/analyze",
    requireEngine(async (req, res) => {
      const body = zAnalyzeRequest.safeParse(req.body);
      if (!body.success) {
        res.status(400).json(zodErrorResponse(body.error));
        return;
      }
      const text = body.data.originalText.slice(0, 20_000);
      const { taskType, confidence } = classifyTaskType(text);
      const score = heuristicScore(text);
      res.json({
        detectedTaskType: taskType,
        confidence,
        scoreDimensions: score.dimensions,
        totalScore: score.total,
        scoreSource: "heuristic_fallback",
        missingInformation: score.missing,
        suggestions: score.suggestions,
        clarificationRequired: false,
        clarificationQuestions: [],
        source: "offline-heuristic",
      });
    }),
  );

  // 404 兜底 + 统一错误处理。
  app.use((_req, res) => {
    res.status(404).json(Err.notFound().toResponse());
  });

  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      log.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      const response =
        err instanceof ApiError ? err.toResponse() : toErrorResponse(err);
      const status = err instanceof ApiError ? err.status : 500;
      res.status(status).json(response);
    },
  );

  return app;
}
