/**
 * Options 页 Provider 表单控制器测试（jsdom）。
 *
 * 验证真实状态与消息参数（不依赖快照）：
 * - 已配置 Key 只显示"已配置"（不回显、不含明文）。
 * - 空 Key 更新不覆盖已有 Key（消息不含 apiKey 字段）。
 * - 输入新 Key 时才发送 apiKey 字段。
 * - 空 Header 名 / CRLF 阻断保存。
 * - 删除需确认；删除默认 Provider 后标记刷新。
 * - 默认 Provider 标记。
 * - 测试与保存相互独立。
 * - 并发测试竞态：旧请求结果不得覆盖新结果。
 * - 测试失败显示安全消息而非原始 Provider 错误。
 */
import { describe, expect, it } from "vitest";
import type { ConnectionTestResult, ProviderSummary } from "@prompt-boost/shared";
import {
  createProviderFormController,
  buildConfig,
  emptyProviderForm,
  validateHeaders,
  sanitizeHeaders,
  payloadWithApiKey,
  apiKeyStatusLabel,
  isDefaultProvider,
  errMsg,
  type ProviderFormDeps,
} from "./provider-form.js";

/** 已配置 Key 的 Provider（列表返回 apiKeyConfigured，不含明文）。 */
const configuredProvider: ProviderSummary = {
  id: "openai-main",
  name: "我的 OpenAI",
  type: "openai",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4o-mini",
  timeoutSeconds: 30,
  enabled: true,
  apiKeyConfigured: true,
};

const unconfiguredProvider: ProviderSummary = { ...configuredProvider, id: "nokey", name: "无 Key", apiKeyConfigured: false };

interface Ctx {
  sent: Record<string, unknown>[];
  ctrl: ReturnType<typeof createProviderFormController>;
}

/** 构造测试上下文：sendMessage 记录消息；controller 附带同步订阅者。 */
function setup(deps: Partial<ProviderFormDeps> = {}): Ctx {
  const sent: Record<string, unknown>[] = [];
  const userSend = deps.sendMessage;
  const ctrl = createProviderFormController({
    ...deps,
    // 记录 wrapper 必须在 deps 之后，确保用户覆盖的 sendMessage 也被记录。
    sendMessage: async (msg) => {
      sent.push(msg);
      if (userSend) return userSend(msg);
      return { ok: true };
    },
  });
  // 触发初始 emit，保证读取 state 前已有一次同步订阅。
  ctrl.subscribe(() => {});
  return { sent, ctrl };
}

/** 一个有效的表单（model 必填，满足保存条件）。 */
function fillValidForm(ctrl: Ctx["ctrl"]): void {
  ctrl.setFormField("name", "我的 OpenAI");
  ctrl.setFormField("model", "gpt-4o-mini");
}

describe("apiKeyStatusLabel（已配置 Key 只显示'已配置'）", () => {
  it("配置了 Key 的 Provider 只显示'已配置'，不包含任何 Key 明文", () => {
    expect(apiKeyStatusLabel(configuredProvider)).toBe("已配置");
    expect(apiKeyStatusLabel(configuredProvider)).not.toMatch(/sk-|key|secret|Bearer/i);
  });

  it("未配置 Key 的 Provider 显示'无 Key'", () => {
    expect(apiKeyStatusLabel(unconfiguredProvider)).toBe("无 Key");
  });
});

describe("空 Key 更新不覆盖已有 Key（消息不含 apiKey 字段）", () => {
  it("编辑已配置 Provider 时留空 Key，保存消息不包含 apiKey 字段", async () => {
    const { sent, ctrl } = setup();
    ctrl.editProvider(configuredProvider); // 密码框不回显，formApiKey 为空。
    ctrl.setFormField("model", "gpt-4o");
    const saved = await ctrl.saveProvider();
    expect(saved).toBe(true);
    const msg = sent.find((m) => m.type === "provider/save");
    expect(msg).toBeDefined();
    expect(msg).not.toHaveProperty("apiKey");
    // 也不允许出现 Key 明文。
    expect(JSON.stringify(sent)).not.toContain("sk-");
  });
});

describe("输入新 API Key 时才发送 apiKey 字段", () => {
  it("未输入 Key 时保存消息不含 apiKey 字段", async () => {
    const { sent, ctrl } = setup();
    fillValidForm(ctrl);
    await ctrl.saveProvider();
    const msg = sent.find((m) => m.type === "provider/save");
    expect(msg).not.toHaveProperty("apiKey");
  });

  it("输入新 Key 时保存消息携带该 apiKey 字段", async () => {
    const { sent, ctrl } = setup();
    fillValidForm(ctrl);
    ctrl.setApiKey("sk-new-secret-xyz");
    await ctrl.saveProvider();
    const msg = sent.find((m) => m.type === "provider/save") as { apiKey?: string };
    expect(msg.apiKey).toBe("sk-new-secret-xyz");
  });
});

describe("空 Header 名阻断保存", () => {
  it("Header 行存在但名称为空时 saveProvider 返回 false 且不发送消息", async () => {
    const { sent, ctrl } = setup();
    fillValidForm(ctrl);
    ctrl.addHeader();
    // 新行 key 为空 → 校验失败。
    const saved = await ctrl.saveProvider();
    expect(saved).toBe(false);
    expect(ctrl.state.formError).toBe("请求头名称不能为空");
    expect(sent.some((m) => m.type === "provider/save")).toBe(false);
  });

  it("validateHeaders 拒绝空名称", () => {
    expect(validateHeaders([{ id: "1", key: "  ", value: "v" }])).toBe("请求头名称不能为空");
    expect(validateHeaders([{ id: "1", key: "", value: "v" }])).toBe("请求头名称不能为空");
  });
});

describe("CRLF 阻断保存", () => {
  it("Header 名含换行时保存被拒绝", async () => {
    const { sent, ctrl } = setup();
    fillValidForm(ctrl);
    ctrl.addHeader();
    const id = ctrl.state.headerRows[0].id;
    ctrl.setHeaderField(id, "key", "X-Api\nKey");
    ctrl.setHeaderField(id, "value", "abc");
    const saved = await ctrl.saveProvider();
    expect(saved).toBe(false);
    expect(ctrl.state.formError).toMatch(/换行/);
    expect(sent.some((m) => m.type === "provider/save")).toBe(false);
  });

  it("Header 值含换行时保存被拒绝", async () => {
    const { sent, ctrl } = setup();
    fillValidForm(ctrl);
    ctrl.addHeader();
    const id = ctrl.state.headerRows[0].id;
    ctrl.setHeaderField(id, "key", "X-Api");
    ctrl.setHeaderField(id, "value", "abc\r\nInjected");
    // 换行保留在表单中，由校验拦截（不得静默吞掉导致注入绕过）。
    expect(ctrl.state.headerRows[0].value).toBe("abc\r\nInjected");
    const saved = await ctrl.saveProvider();
    expect(saved).toBe(false);
    expect(ctrl.state.formError).toMatch(/换行/);
    expect(sent.some((m) => m.type === "provider/save")).toBe(false);
  });

  it("setHeaderField 名称含换行时 validateHeaders 拦截", () => {
    const { ctrl } = setup();
    ctrl.addHeader();
    const id = ctrl.state.headerRows[0].id;
    ctrl.setHeaderField(id, "key", "X-Api\r\nHost");
    ctrl.setHeaderField(id, "value", "abc");
    expect(validateHeaders(ctrl.state.headerRows)).toMatch(/换行/);
  });
});

describe("删除需确认", () => {
  it("confirm 拒绝时不发删除消息", async () => {
    const { sent, ctrl } = setup({ confirm: () => false });
    await ctrl.removeProvider("openai-main");
    expect(sent.some((m) => m.type === "provider/delete")).toBe(false);
  });

  it("confirm 同意时发送删除消息", async () => {
    const { sent, ctrl } = setup({ confirm: () => true });
    await ctrl.removeProvider("openai-main");
    const msg = sent.find((m) => m.type === "provider/delete");
    expect(msg).toMatchObject({ type: "provider/delete", id: "openai-main" });
  });
});

describe("删除默认 Provider 后标记刷新", () => {
  it("删除当前默认 Provider 后 activeProviderId 清空、列表刷新", async () => {
    let deleted = false;
    const { sent, ctrl } = setup({
      confirm: () => true,
      sendMessage: async (msg) => {
        if (msg.type === "provider/list") {
          // 删除前：默认是 openai-main；删除后：默认清空。
          if (deleted) return { providers: [], activeProviderId: null };
          return { providers: [configuredProvider], activeProviderId: "openai-main" };
        }
        if (msg.type === "provider/delete") {
          deleted = true;
          return { ok: true };
        }
        if (msg.type === "provider/set-default") return { ok: true };
        return { ok: true };
      },
    });
    // 先设为默认（模拟持久化默认），再删除。
    await ctrl.setDefault("openai-main");
    expect(ctrl.state.activeProviderId).toBe("openai-main");
    await ctrl.removeProvider("openai-main");
    expect(ctrl.state.activeProviderId).toBeNull();
    // 删除后应重新加载列表。
    expect(sent.filter((m) => m.type === "provider/list").length).toBeGreaterThan(0);
  });
});

describe("默认 Provider 标记", () => {
  it("isDefaultProvider 只在 id 匹配且非空时返回 true", () => {
    expect(isDefaultProvider("a", "a")).toBe(true);
    expect(isDefaultProvider("b", "a")).toBe(false);
    expect(isDefaultProvider("a", null)).toBe(false);
  });

  it("provider/list 响应的 activeProviderId 用于标记默认 Provider", async () => {
    const { ctrl } = setup({
      sendMessage: async (msg) => {
        if (msg.type === "provider/list") {
          return { providers: [configuredProvider, unconfiguredProvider], activeProviderId: "openai-main" };
        }
        return { ok: true };
      },
    });
    await ctrl.loadProviders();
    expect(ctrl.state.providers.length).toBe(2);
    expect(isDefaultProvider(configuredProvider.id, ctrl.state.activeProviderId)).toBe(true);
  });
});

describe("测试与保存相互独立", () => {
  it("测试消息类型为 provider/test，保存为 provider/save，互不影响", async () => {
    const { sent, ctrl } = setup();
    fillValidForm(ctrl);
    ctrl.setApiKey("sk-for-test");
    await ctrl.testProvider();
    await ctrl.saveProvider();
    const types = sent.map((m) => m.type);
    expect(types).toContain("provider/test");
    expect(types).toContain("provider/save");
    // 测试不会把 testing 状态带到保存（保存正常完成）。
    expect(ctrl.state.testing).toBe(false);
    expect(ctrl.state.saving).toBe(false);
  });

  it("测试失败不影响后续保存", async () => {
    const { ctrl } = setup({
      sendMessage: async (msg) => {
        if (msg.type === "provider/test") {
          return { success: false, providerId: "x", providerType: "openai", model: "m", latencyMs: 10, checkedAt: new Date().toISOString(), error: { code: "upstream", message: "上游拒绝" } };
        }
        if (msg.type === "provider/list") return { providers: [] };
        return { ok: true };
      },
    });
    fillValidForm(ctrl);
    await ctrl.testProvider();
    expect(ctrl.state.testResult?.success).toBe(false);
    // 保存仍然成功。
    const saved = await ctrl.saveProvider();
    expect(saved).toBe(true);
  });
});

describe("并发测试竞态：旧结果不得覆盖新结果", () => {
  function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
  }

  it("先发出慢请求、后发出快请求，最终保留快请求（新）的结果", async () => {
    const d1 = deferred<ConnectionTestResult>();
    const d2 = deferred<ConnectionTestResult>();
    const ok = (success: boolean): ConnectionTestResult => ({
      success,
      providerId: "p",
      providerType: "openai",
      model: "gpt-4o-mini",
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
    });
    let call = 0;
    const { ctrl } = setup({
      sendMessage: () => {
        call += 1;
        return call === 1 ? d1.promise : d2.promise;
      },
    });
    fillValidForm(ctrl);
    const p1 = ctrl.testProvider(); // 慢（旧）
    const p2 = ctrl.testProvider(); // 快（新）
    // 新请求先返回成功。
    d2.resolve(ok(true));
    await p2;
    // 旧请求后返回失败——必须被丢弃。
    d1.resolve(ok(false));
    await p1;
    expect(ctrl.state.testResult?.success).toBe(true);
    expect(ctrl.state.testing).toBe(false);
  });
});

describe("测试失败显示安全消息而非原始 Provider 错误", () => {
  it("错误对象包含不安全字段时只展示 safeMessage", async () => {
    const { ctrl } = setup({
      sendMessage: async (msg) => {
        if (msg.type === "provider/test") {
          return {
            success: false,
            providerId: "p",
            providerType: "openai",
            model: "m",
            latencyMs: 0,
            checkedAt: new Date().toISOString(),
            error: {
              code: "upstream",
              message: "上游 401：api_key 无效",
            },
          };
        }
        return { ok: true };
      },
    });
    fillValidForm(ctrl);
    await ctrl.testProvider();
    expect(ctrl.state.testResult?.success).toBe(false);
    // 渲染取 error.message；此处保证状态里是可显示的安全消息而非 Key 明文。
    expect(ctrl.state.testResult?.error?.message).toBe("上游 401：api_key 无效");
    expect(JSON.stringify(ctrl.state.testResult)).not.toContain("sk-");
  });
});

describe("payloadWithApiKey（apiKey 字段条件发送）", () => {
  it("空 Key 时消息不含 apiKey 字段", () => {
    expect(payloadWithApiKey({ type: "provider/save" }, "")).not.toHaveProperty("apiKey");
  });
  it("非空 Key 时消息携带 apiKey", () => {
    expect(payloadWithApiKey({ type: "provider/save" }, "sk-1")).toHaveProperty("apiKey", "sk-1");
  });
});

describe("sanitizeHeaders（Header 清理）", () => {
  it("跳过空名称与含换行的行", () => {
    const rows = [
      { id: "1", key: "X-Api", value: "abc" },
      { id: "2", key: "", value: "skip-empty" },
      { id: "3", key: "X-Inject", value: "a\r\nb" },
      { id: "4", key: "X-Newline\r\nHost", value: "v" },
    ];
    const out = sanitizeHeaders(rows);
    expect(out).toEqual({ "X-Api": "abc" });
  });
});

describe("非思考模式 Provider 配置", () => {
  it("新建 Provider 默认不开启非思考模式", () => {
    expect(emptyProviderForm().disableThinking).toBe(false);
  });

  it("编辑和构建配置时保留已开启的非思考模式", () => {
    const { ctrl } = setup();
    ctrl.editProvider({
      ...configuredProvider,
      type: "openai-compatible",
      baseUrl: "https://www.packyapi.ai/v1",
      model: "deepseek-v4-flash",
      disableThinking: true,
    });

    expect(ctrl.state.form.disableThinking).toBe(true);
    expect(buildConfig(ctrl.state.form, ctrl.state.headerRows).disableThinking).toBe(true);
  });

  it("从 OpenAI-Compatible 切换到其它类型时强制关闭非思考模式", () => {
    const { ctrl } = setup();
    ctrl.setType("openai-compatible");
    ctrl.setFormField("disableThinking", true);
    expect(ctrl.state.form.disableThinking).toBe(true);

    ctrl.setType("anthropic");
    expect(ctrl.state.form.disableThinking).toBe(false);
  });
});

describe("errMsg（错误对象渲染，修复 G）", () => {
  it("对象错误渲染为 message 而非 [object Object]", () => {
    expect(errMsg({ code: "background", message: "令牌无效" })).toBe("令牌无效");
    expect(errMsg({ message: "连接被拒绝" })).toBe("连接被拒绝");
  });

  it("字符串原样返回", () => {
    expect(errMsg("本地服务不可用")).toBe("本地服务不可用");
  });

  it("无 message 或 message 过长时回退", () => {
    expect(errMsg({ code: "x" })).toBe("请求失败");
    expect(errMsg(undefined)).toBe("请求失败");
    expect(errMsg({ message: "a".repeat(500) })).toBe("请求失败");
  });

  it("saveProvider 收到对象 error 时 formError 显示 message 而非 [object Object]", async () => {
    const { sent, ctrl } = setup({
      sendMessage: async () => ({ error: { code: "validation", message: "模型不能为空" } }),
    });
    fillValidForm(ctrl);
    const saved = await ctrl.saveProvider();
    expect(saved).toBe(false);
    // 修复 G：不再渲染 "[object Object]"。
    expect(ctrl.state.formError).toBe("保存失败：模型不能为空");
    expect(ctrl.state.formError).not.toContain("[object Object]");
    expect(sent.some((m) => m.type === "provider/save")).toBe(true);
  });
});

describe("listModels（拉取可用模型列表）", () => {
  it("成功拉取后 models 填充、loading 复位、formError 清空", async () => {
    const { sent, ctrl } = setup({
      sendMessage: async (msg) => {
        if (msg.type === "provider/models") return { providerType: "openai", models: ["gpt-4o", "gpt-4o-mini"] };
        return { ok: true };
      },
    });
    fillValidForm(ctrl);
    await ctrl.listModels();
    expect(ctrl.state.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(ctrl.state.loadingModels).toBe(false);
    expect(ctrl.state.formError).toBe("");
    // 请求体携带 config 与 apiKey。
    const msg = sent.find((m) => m.type === "provider/models") as { config?: unknown; apiKey?: string };
    expect(msg.config).toBeDefined();
    expect(msg.apiKey).toBeUndefined();
  });

  it("拉取中输入新 Key 时消息携带 apiKey", async () => {
    const { sent, ctrl } = setup({
      sendMessage: async () => ({ providerType: "openai", models: ["gpt-4o"] }),
    });
    fillValidForm(ctrl);
    ctrl.setApiKey("sk-models-123");
    await ctrl.listModels();
    const msg = sent.find((m) => m.type === "provider/models") as { apiKey?: string };
    expect(msg.apiKey).toBe("sk-models-123");
  });

  it("失败（对象 error）时 models 清空并显示安全错误", async () => {
    const { ctrl } = setup({
      sendMessage: async () => ({ error: { code: "INVALID_API_KEY", message: "API Key 无效" } }),
    });
    fillValidForm(ctrl);
    await ctrl.listModels();
    expect(ctrl.state.models).toEqual([]);
    expect(ctrl.state.loadingModels).toBe(false);
    expect(ctrl.state.formError).toBe("获取模型失败：API Key 无效");
    expect(ctrl.state.formError).not.toContain("[object Object]");
  });

  it("Header 校验失败时不发请求，models 清空", async () => {
    const { sent, ctrl } = setup();
    fillValidForm(ctrl);
    ctrl.addHeader(); // 空名称 Header 行 → validateHeaders 失败。
    await ctrl.listModels();
    expect(sent.some((m) => m.type === "provider/models")).toBe(false);
    expect(ctrl.state.loadingModels).toBe(false);
    expect(ctrl.state.models).toEqual([]);
  });

  it("并发竞态：旧请求结果不覆盖新请求结果", async () => {
    let resolveFirst: (v: unknown) => void = () => {};
    const first = new Promise<unknown>((r) => { resolveFirst = r; });
    let call = 0;
    const { ctrl } = setup({
      sendMessage: async () => {
        call += 1;
        if (call === 1) return first; // 第一次挂起。
        return { providerType: "openai", models: ["gpt-4o-new"] };
      },
    });
    fillValidForm(ctrl);
    const p1 = ctrl.listModels();
    // 第二次立即完成。
    await ctrl.listModels();
    expect(ctrl.state.models).toEqual(["gpt-4o-new"]);
    // 第一次迟到：不得覆盖。
    resolveFirst({ providerType: "openai", models: ["gpt-4o-stale"] });
    await p1;
    expect(ctrl.state.models).toEqual(["gpt-4o-new"]);
  });

  it("切换类型后清空模型列表（旧列表不再适用）", async () => {
    const { ctrl } = setup({
      sendMessage: async () => ({ providerType: "openai", models: ["gpt-4o"] }),
    });
    fillValidForm(ctrl);
    await ctrl.listModels();
    expect(ctrl.state.models).toHaveLength(1);
    ctrl.setType("anthropic");
    expect(ctrl.state.models).toEqual([]);
  });
});
