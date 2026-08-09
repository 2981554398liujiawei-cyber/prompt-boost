/**
 * Provider 表单逻辑（与 React 解耦，便于单元测试）。
 *
 * 职责：管理 Options 页 Provider 配置表单的全部状态与动作——
 * 类型切换 / 字段编辑 / Header 校验 / API Key 处理 / 测试与保存分离 /
 * 并发测试竞态防护（旧结果不得覆盖新结果）/ 删除确认 / 默认 Provider 标记。
 *
 * 安全约定：
 * - 已保存 Key 永不回显：编辑时 password 输入框始终为空，仅显示"已配置"。
 * - apiKey 只在用户输入新 Key 时随消息发送；留空则消息不含 apiKey 字段。
 * - Header 名/值含换行或 Header 名为空时拒绝保存（防注入）。
 */
import type {
  ConnectionTestResult,
  ProviderConfig,
  ProviderSummary,
  ProviderType,
} from "@prompt-boost/shared";

export interface HeaderRow {
  id: string;
  key: string;
  value: string;
}

export interface ProviderFormState {
  providers: ProviderSummary[];
  activeProviderId: string | null;
  form: ProviderConfig;
  formApiKey: string;
  headerRows: HeaderRow[];
  editingId: string | null;
  testResult: ConnectionTestResult | null;
  testing: boolean;
  saving: boolean;
  /** 拉取到的可用模型列表（「获取可用模型」按钮结果）。 */
  models: string[];
  /** 拉取中（按钮禁用、显示"获取中…"）。 */
  loadingModels: boolean;
  formError: string;
  saveMsg: string;
}

export type SendMessage = (msg: Record<string, unknown>) => Promise<unknown>;

export interface ProviderFormDeps {
  sendMessage: SendMessage;
  /** 删除确认。默认 window.confirm；测试注入假实现。 */
  confirm?: (message: string) => boolean;
}

export const PROVIDER_META: Record<
  ProviderType,
  { label: string; defaultBase: string; modelPlaceholder: string; needsBase: boolean }
> = {
  openai: { label: "OpenAI", defaultBase: "https://api.openai.com/v1", modelPlaceholder: "如 gpt-4o / gpt-4o-mini（必填）", needsBase: false },
  anthropic: { label: "Anthropic", defaultBase: "https://api.anthropic.com/v1", modelPlaceholder: "如 claude-sonnet-4 / claude-3-5-sonnet（必填）", needsBase: false },
  "openai-compatible": { label: "OpenAI-Compatible", defaultBase: "", modelPlaceholder: "模型名称（必填，不自动猜测）", needsBase: true },
};

export function newHeaderId(): string {
  return `h-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 把未知类型的错误统一为可显示字符串。
 * 修复 G：background 返回的 error 是对象 { code, message }，直接插值会渲染成
 * "[object Object]"。取 message 字段；字符串原样；其余回退。
 */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0 && m.length < 300) return m;
  }
  return "请求失败";
}

/** 清理 Header：去空白、跳过空名、剔除含换行的行。 */
export function sanitizeHeaders(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const k = row.key.trim();
    const v = row.value.trim();
    if (!k || /[\r\n]/.test(k) || /[\r\n]/.test(v)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 校验 Header 是否可保存。返回错误消息或 null。
 * - Header 名不能为空（存在该行时）。
 * - Header 名或值不得包含换行符（防 CRLF 注入）。
 */
export function validateHeaders(rows: HeaderRow[]): string | null {
  for (const row of rows) {
    if (!row.key.trim()) {
      return "请求头名称不能为空";
    }
    if (/[\r\n]/.test(row.key) || /[\r\n]/.test(row.value)) {
      return "请求头名称或值不能包含换行符";
    }
  }
  return null;
}

/** 已保存 Key 的展示标签：只显示"已配置"，绝不含 Key 明文。 */
export function apiKeyStatusLabel(provider: ProviderSummary): string {
  return provider.apiKeyConfigured ? "已配置" : "无 Key";
}

/** 默认 Provider 标记（渲染用）。 */
export function isDefaultProvider(providerId: string, activeProviderId: string | null): boolean {
  return Boolean(activeProviderId && providerId === activeProviderId);
}

/** 构造待保存的 Provider 配置。id 为空时自动生成。 */
export function buildConfig(
  form: ProviderConfig,
  headerRows: HeaderRow[],
): ProviderConfig {
  return {
    ...form,
    id: form.id || `provider-${Date.now()}`,
    customHeaders: sanitizeHeaders(headerRows),
  };
}

/** API Key 处理：留空则不发送 apiKey 字段（不覆盖已存 Key）；有新值才发送。 */
export function payloadWithApiKey<T extends Record<string, unknown>>(
  base: T,
  apiKey: string,
): T & { apiKey?: string } {
  return apiKey ? { ...base, apiKey } : base;
}

export interface ProviderFormController {
  state: ProviderFormState;
  subscribe(fn: (s: ProviderFormState) => void): () => void;
  setType(type: ProviderType): void;
  setFormField<K extends keyof ProviderConfig>(field: K, value: ProviderConfig[K]): void;
  setApiKey(value: string): void;
  addHeader(): void;
  removeHeader(id: string): void;
  setHeaderField(id: string, field: "key" | "value", value: string): void;
  loadProviders(): Promise<void>;
  testProvider(): Promise<void>;
  saveProvider(): Promise<boolean>;
  /** 拉取可用模型列表（失败时清空列表并显示错误，不阻塞手动输入）。 */
  listModels(): Promise<void>;
  editProvider(p: ProviderSummary): void;
  cancelEdit(): void;
  removeProvider(id: string): Promise<void>;
  setDefault(id: string): Promise<void>;
  clearSaveMsg(): void;
}

/** 新建 Provider 的空表单（model 必填，不预填任何模型名）。 */
export function emptyProviderForm(): ProviderConfig {
  return {
    id: "",
    type: "openai",
    name: "",
    baseUrl: PROVIDER_META.openai.defaultBase,
    model: "",
    timeoutSeconds: 30,
    disableThinking: false,
    enabled: true,
  };
}

const initialState = (): ProviderFormState => ({
  providers: [],
  activeProviderId: null,
  form: emptyProviderForm(),
  formApiKey: "",
  headerRows: [],
  editingId: null,
  testResult: null,
  testing: false,
  saving: false,
  models: [],
  loadingModels: false,
  formError: "",
  saveMsg: "",
});

export function createProviderFormController(deps: ProviderFormDeps): ProviderFormController {
  let state = initialState();
  const listeners = new Set<(s: ProviderFormState) => void>();
  const confirm =
    deps.confirm ?? ((message: string) => window.confirm(message));

  const emit = (): void => {
    for (const fn of listeners) fn(state);
  };

  /** 竞态防护：只有最新一次测试的结果才能落地。 */
  let testEpoch = 0;
  /** 竞态防护：只有最新一次模型列表拉取的结果才能落地（与测试相互独立）。 */
  let modelsEpoch = 0;

  const setPartial = (patch: Partial<ProviderFormState>): void => {
    state = { ...state, ...patch };
    emit();
  };

  const loadProviders = async (): Promise<void> => {
    const res = (await deps.sendMessage({ type: "provider/list" })) as
      | { providers: ProviderSummary[]; activeProviderId?: string | null }
      | { error: string };
    if ("error" in res) {
      setPartial({ saveMsg: `无法读取 Provider：${errMsg(res.error)}` });
      return;
    }
    setPartial({
      providers: res.providers,
      // 同步 local-agent 持久化的默认 Provider 标记；仅当响应带该字段时更新。
      ...("activeProviderId" in res ? { activeProviderId: res.activeProviderId ?? null } : {}),
    });
  };

  const testProvider = async (): Promise<void> => {
    const epoch = ++testEpoch;
    setPartial({ testing: true, testResult: null, formError: "" });
    try {
      const config = buildConfig(state.form, state.headerRows);
      const headerError = validateHeaders(state.headerRows);
      if (headerError) {
        if (epoch === testEpoch) {
          setPartial({ testing: false, formError: headerError });
        }
        return;
      }
      const res = (await deps.sendMessage(
        payloadWithApiKey({ type: "provider/test", config }, state.formApiKey),
      )) as ConnectionTestResult | { error: string };
      if (epoch !== testEpoch) return; // 旧结果，丢弃。
      // 判定标准：成功的测试结果带 success 字段；错误响应是 { error: string }。
      // 失败的 ConnectionTestResult（success:false + error 对象）仍要写入 testResult。
      if (!("success" in res)) {
        setPartial({
          testing: false,
          formError: `测试失败：${typeof res.error === "string" ? res.error : "请求失败"}`,
        });
        return;
      }
      setPartial({ testing: false, testResult: res });
    } catch (err) {
      if (epoch !== testEpoch) return;
      setPartial({
        testing: false,
        formError: `测试失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const listModels = async (): Promise<void> => {
    const epoch = ++modelsEpoch;
    setPartial({ loadingModels: true, formError: "" });
    try {
      const config = buildConfig(state.form, state.headerRows);
      const headerError = validateHeaders(state.headerRows);
      if (headerError) {
        if (epoch === modelsEpoch) {
          setPartial({ loadingModels: false, models: [], formError: headerError });
        }
        return;
      }
      const res = (await deps.sendMessage(
        payloadWithApiKey({ type: "provider/models", config }, state.formApiKey),
      )) as { providerType?: string; models?: string[] } | { error: string };
      if (epoch !== modelsEpoch) return; // 旧结果，丢弃。
      if ("error" in res) {
        setPartial({
          loadingModels: false,
          models: [],
          formError: `获取模型失败：${errMsg(res.error)}`,
        });
        return;
      }
      setPartial({
        loadingModels: false,
        models: Array.isArray(res.models) ? res.models : [],
      });
    } catch (err) {
      if (epoch !== modelsEpoch) return;
      setPartial({
        loadingModels: false,
        models: [],
        formError: `获取模型失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const saveProvider = async (): Promise<boolean> => {
    const headerError = validateHeaders(state.headerRows);
    if (headerError) {
      setPartial({ formError: headerError });
      return false;
    }
    setPartial({ saving: true, formError: "" });
    try {
      const config = buildConfig(state.form, state.headerRows);
      const msg = payloadWithApiKey(
        { type: "provider/save", config, isNew: !state.editingId },
        state.formApiKey,
      );
      const res = (await deps.sendMessage(msg)) as
        | { provider: ProviderSummary }
        | { error: string };
      if ("error" in res) {
        setPartial({ saving: false, formError: `保存失败：${errMsg(res.error)}` });
        return false;
      }
      setPartial({
        saving: false,
        saveMsg: state.editingId ? "Provider 已更新（空 Key 保留原 Key）" : "Provider 已添加（Key 已写入本机安全存储）",
        formApiKey: "",
        headerRows: [],
        editingId: null,
        form: emptyProviderForm(),
        testResult: null,
        models: [],
        loadingModels: false,
      });
      await loadProviders();
      return true;
    } catch (err) {
      setPartial({
        saving: false,
        formError: `保存失败：${err instanceof Error ? err.message : String(err)}`,
      });
      return false;
    }
  };

  const editProvider = (p: ProviderSummary): void => {
    setPartial({
      editingId: p.id,
      form: {
        id: p.id,
        type: p.type,
        name: p.name,
        baseUrl: p.baseUrl ?? "",
        model: p.model,
        timeoutSeconds: p.timeoutSeconds,
        disableThinking: p.disableThinking ?? false,
        enabled: p.enabled,
      },
      // 已保存 Key 永不回显：密码框始终为空。
      formApiKey: "",
      headerRows: Object.entries(p.customHeaders ?? {}).map(([key, value]) => ({
        id: newHeaderId(),
        key,
        value,
      })),
      testResult: null,
      formError: "",
      models: [],
      loadingModels: false,
    });
  };

  const cancelEdit = (): void => {
    setPartial({
      editingId: null,
      formApiKey: "",
      testResult: null,
      formError: "",
      headerRows: [],
      models: [],
      loadingModels: false,
      form: emptyProviderForm(),
    });
  };

  const removeProvider = async (id: string): Promise<void> => {
    if (!confirm("删除该 Provider？其 API Key 也会一并清除。")) return;
    const res = (await deps.sendMessage({
      type: "provider/delete",
      id,
    })) as { ok: true } | { error: string };
    if ("error" in res) {
      setPartial({ saveMsg: `删除失败：${errMsg(res.error)}` });
      return;
    }
    // 删除默认 Provider 后清除标记，并刷新列表。
    setPartial({
      activeProviderId: state.activeProviderId === id ? null : state.activeProviderId,
      saveMsg: "Provider 已删除",
    });
    await loadProviders();
  };

  const setDefault = async (id: string): Promise<void> => {
    const res = (await deps.sendMessage({
      type: "provider/set-default",
      id,
    })) as { ok: true } | { error: string };
    if ("error" in res) {
      setPartial({ saveMsg: `设置默认失败：${errMsg(res.error)}` });
      return;
    }
    setPartial({ activeProviderId: id });
    await loadProviders();
  };

  const controller: ProviderFormController = {
    get state() {
      return state;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setType(type) {
      const meta = PROVIDER_META[type];
      setPartial({
        form: {
          ...state.form,
          type,
          // `thinking` 是 DeepSeek/OpenAI-Compatible 扩展字段；切到其它类型时关闭。
          disableThinking:
            type === "openai-compatible" ? (state.form.disableThinking ?? false) : false,
          // 仅当 baseUrl 还是另一个类型的默认值时替换；用户自定义值保留。
          baseUrl:
            state.form.baseUrl &&
            state.form.baseUrl !== PROVIDER_META.openai.defaultBase &&
            state.form.baseUrl !== PROVIDER_META.anthropic.defaultBase
              ? state.form.baseUrl
              : meta.defaultBase,
          // model 绝不自动填充默认值——避免保存过期模型名。
        },
        // 类型切换后旧模型列表不再适用，立即失效。
        models: [],
        loadingModels: false,
      });
    },
    setFormField(field, value) {
      setPartial({ form: { ...state.form, [field]: value } });
    },
    setApiKey(value) {
      setPartial({ formApiKey: value });
    },
    addHeader() {
      setPartial({
        headerRows: [...state.headerRows, { id: newHeaderId(), key: "", value: "" }],
      });
    },
    removeHeader(id) {
      setPartial({ headerRows: state.headerRows.filter((r) => r.id !== id) });
    },
    setHeaderField(id, field, value) {
      // 保留原样输入；换行由 validateHeaders 在保存/测试时拦截（CRLF 阻断保存）。
      setPartial({
        headerRows: state.headerRows.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
      });
    },
    loadProviders,
    testProvider,
    saveProvider,
    listModels,
    editProvider,
    cancelEdit,
    removeProvider,
    setDefault,
    clearSaveMsg() {
      setPartial({ saveMsg: "" });
    },
  };

  return controller;
}
