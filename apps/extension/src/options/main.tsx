/**
 * Options 页：API Provider 配置、本地服务连接、默认模式、隐私说明。
 *
 * Provider 管理走 local-agent（Vault 保存 API Key）：
 * - 完整 API Key 只在本页输入，经 background 转发到 local-agent，不写入 chrome.storage。
 * - 已保存 Provider 的 Key 不回显（密码框占位提示"已配置"，绝不显示 Key 明文）。
 * - 空 Key 保存时不覆盖已有 Key。
 * - 测试连接与保存分离：先测试通过再保存。
 *
 * 表单状态与全部动作集中在 provider-form.ts 控制器（便于单元测试）；
 * 本组件只负责渲染与把事件转发给控制器。
 */
import { useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { ProviderConfig, ProviderSummary, Settings } from "@prompt-boost/shared";
import { getExtensionSettings, saveExtensionSettings } from "../background/settings.js";
import {
  PROVIDER_META,
  createProviderFormController,
  emptyProviderForm,
  isDefaultProvider,
  type ProviderFormController,
} from "./provider-form.js";

type ConnState = "idle" | "testing" | "ok" | "fail";

function Options() {
  // ── 控制器状态镜像（subscribe 同步，避免每次渲染重建控制器）────
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string | null>(null);
  const [form, setForm] = useState<ProviderConfig>(() => emptyProviderForm());
  const [formApiKey, setFormApiKey] = useState("");
  const [headerRows, setHeaderRows] = useState<{ id: string; key: string; value: string }[]>([]);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [formError, setFormError] = useState("");
  const [testResult, setTestResult] = useState<import("@prompt-boost/shared").ConnectionTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);

  const [controller, setController] = useState<ProviderFormController | null>(null);

  // 页面级设置。
  const [localAgentUrl, setLocalAgentUrl] = useState("http://127.0.0.1:8787");
  const [localAgentToken, setLocalAgentToken] = useState("");
  const [defaultEnhanceLevel, setDefaultEnhanceLevel] = useState<Settings["enhanceLevel"]>("deep");
  const [defaultClarificationMode, setDefaultClarificationMode] =
    useState<Settings["clarificationMode"]>("smart");
  const [defaultTaskType, setDefaultTaskType] = useState<Settings["taskType"]>("auto");
  const [conn, setConn] = useState<ConnState>("idle");
  const [connMsg, setConnMsg] = useState("");
  const [saveMsg, setSaveMsg] = useState("");

  useEffect(() => {
    const ctrl = createProviderFormController({
      sendMessage: (msg) => chrome.runtime.sendMessage(msg),
    });
    setController(ctrl);
    const unsubscribe = ctrl.subscribe((s) => {
      setProviders(s.providers);
      setActiveProviderId(s.activeProviderId);
      setForm({ ...s.form });
      setFormApiKey(s.formApiKey);
      setHeaderRows(s.headerRows.map((r) => ({ ...r })));
      setEditingId(s.editingId ?? undefined);
      setFormError(s.formError);
      setTestResult(s.testResult);
      setTesting(s.testing);
      setSaving(s.saving);
      setModels(s.models);
      setLoadingModels(s.loadingModels);
      if (s.saveMsg) setSaveMsg(s.saveMsg);
    });
    void getExtensionSettings().then((s) => {
      setLocalAgentUrl(s.localAgentUrl);
      setLocalAgentToken(s.localAgentToken ?? "");
      setDefaultEnhanceLevel(s.defaultEnhanceLevel);
      setDefaultClarificationMode(s.defaultClarificationMode);
      setDefaultTaskType(s.defaultTaskType);
    });
    void ctrl.loadProviders();
    return unsubscribe;
  }, []);

  const meta = PROVIDER_META[form.type];

  const testConnection = async (): Promise<void> => {
    setConn("testing");
    setConnMsg("正在测试…");
    const res = (await chrome.runtime.sendMessage({ type: "local-agent/ping" })) as { ok: boolean } | undefined;
    if (res?.ok) {
      setConn("ok");
      setConnMsg("本地服务连接成功");
    } else {
      setConn("fail");
      setConnMsg("无法连接本地服务：请确认 local-agent 已启动（127.0.0.1:8787）");
    }
  };

  const saveDefaults = async (): Promise<void> => {
    await saveExtensionSettings({
      localAgentUrl,
      localAgentToken: localAgentToken || undefined,
      defaultEnhanceLevel,
      defaultClarificationMode,
      defaultTaskType,
    });
    setSaveMsg("已保存");
    window.setTimeout(() => setSaveMsg(""), 1500);
  };

  const handleSave = (e: FormEvent): void => {
    e.preventDefault();
    void controller?.saveProvider();
  };

  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1>✨ Prompt Boost 设置</h1>

      <section style={{ marginBottom: 24 }}>
        <h2>本地服务</h2>
        <label>
          服务地址
          <input value={localAgentUrl} onChange={(e) => setLocalAgentUrl(e.target.value)} style={inputStyle} />
        </label>
        <label>
          本机令牌（运行 `pnpm agent:token:show` 获取）
          <input value={localAgentToken} onChange={(e) => setLocalAgentToken(e.target.value)} placeholder="粘贴本地服务令牌" style={inputStyle} type="password" />
        </label>
        <div style={{ marginTop: 8 }}>
          <button onClick={() => void testConnection()} disabled={conn === "testing"}>
            {conn === "testing" ? "测试中…" : "测试连接"}
          </button>
          {connMsg && (
            <span style={{ marginLeft: 8, color: conn === "ok" ? "#10a37f" : "#d94343" }}>{connMsg}</span>
          )}
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2>默认增强设置</h2>
        <label>
          增强模式
          <select value={defaultEnhanceLevel} onChange={(e) => setDefaultEnhanceLevel(e.target.value as Settings["enhanceLevel"])} style={inputStyle}>
            <option value="quick">快速增强</option>
            <option value="deep">深度增强（推荐）</option>
            <option value="expert">专家增强</option>
          </select>
        </label>
        <label>
          自动追问
          <select value={defaultClarificationMode} onChange={(e) => setDefaultClarificationMode(e.target.value as Settings["clarificationMode"])} style={inputStyle}>
            <option value="off">关闭</option>
            <option value="smart">智能判断（推荐）</option>
            <option value="always">总是追问</option>
          </select>
        </label>
        <label>
          任务类型
          <select value={defaultTaskType} onChange={(e) => setDefaultTaskType(e.target.value as Settings["taskType"])} style={inputStyle}>
            <option value="auto">自动识别（推荐）</option>
            <option value="writing">写作</option>
            <option value="coding">编程</option>
            <option value="business">商业</option>
            <option value="analysis">分析</option>
            <option value="research">研究</option>
            <option value="learning">学习</option>
            <option value="translation">翻译</option>
            <option value="planning">规划</option>
            <option value="creative">创意</option>
            <option value="general">通用</option>
          </select>
        </label>
        <div style={{ marginTop: 8 }}>
          <button onClick={() => void saveDefaults()}>保存默认设置</button>
          {saveMsg && <span style={{ marginLeft: 8, color: "#10a37f" }}>{saveMsg}</span>}
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h2>API Provider（BYOK）</h2>
        <p style={{ fontSize: 13, color: "#666" }}>
          API Key 由本地服务写入系统凭证库 / 加密文件；扩展与页面都不会保存完整 Key。已保存的 Key 不会回显。
        </p>

        <form onSubmit={(e) => void handleSave(e)} style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select value={form.type} onChange={(e) => controller?.setType(e.target.value as never)} style={{ ...inputStyle, flex: 1 }}>
              {Object.entries(PROVIDER_META).map(([t, m]) => (
                <option key={t} value={t}>{m.label}</option>
              ))}
            </select>
            <label style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={form.enabled} onChange={(e) => controller?.setFormField("enabled", e.target.checked)} />
              启用
            </label>
          </div>
          <input placeholder="Provider ID（可选，自动生成）" value={form.id} onChange={(e) => controller?.setFormField("id", e.target.value)} style={inputStyle} />
          <input placeholder="名称（如：我的 OpenAI）" value={form.name} onChange={(e) => controller?.setFormField("name", e.target.value)} style={inputStyle} />
          <input
            placeholder={meta.needsBase ? "API Base URL（必填，如 https://xxx/v1）" : "API Base URL（留空用官方默认）"}
            value={form.baseUrl ?? ""}
            onChange={(e) => controller?.setFormField("baseUrl", e.target.value)}
            style={inputStyle}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              placeholder={meta.modelPlaceholder}
              value={form.model}
              onChange={(e) => controller?.setFormField("model", e.target.value)}
              style={{ ...inputStyle, flex: 1, margin: "4px 0 10px" }}
            />
            <button
              type="button"
              onClick={() => void controller?.listModels()}
              disabled={loadingModels}
              style={{ marginBottom: 10, whiteSpace: "nowrap" }}
              title="拉取该 Provider 的可用模型列表（需先填写 Base URL 与 API Key）"
            >
              {loadingModels ? "获取中…" : "获取可用模型"}
            </button>
          </div>
          {models.length > 0 && (
            <label style={{ display: "block", fontSize: 13, marginBottom: 10 }}>
              选择模型
              <select
                value={form.model}
                onChange={(e) => controller?.setFormField("model", e.target.value)}
                style={inputStyle}
              >
                {/* 当前手动输入的值若不在列表中，单独列出，避免选中态丢失。 */}
                {form.model && !models.includes(form.model) && (
                  <option value={form.model}>当前值：{form.model}</option>
                )}
                {models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
                <option value="">手动输入</option>
              </select>
            </label>
          )}
          <input
            placeholder="API Key（留空则保留已保存的 Key）"
            value={formApiKey}
            onChange={(e) => controller?.setApiKey(e.target.value)}
            style={inputStyle}
            type="password"
            autoComplete="off"
          />

          {form.type === "openai-compatible" && (
            <label
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: "8px 10px",
                border: "1px solid #e5e5e5",
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={form.disableThinking ?? false}
                onChange={(e) => controller?.setFormField("disableThinking", e.target.checked)}
              />
              <span>
                非思考模式
                <small style={{ display: "block", color: "#777", marginTop: 2 }}>
                  开启后发送 DeepSeek 兼容参数 thinking.type=disabled；关闭时不发送该字段。
                </small>
              </span>
            </label>
          )}

          <div>
            <div style={{ fontSize: 13, marginBottom: 4 }}>自定义请求头（可选；用于中转网关鉴权，不会写入日志）</div>
            {headerRows.map((row) => (
              <div key={row.id} style={{ display: "flex", gap: 4, marginBottom: 4 }}>
                <input placeholder="Header 名" value={row.key} onChange={(e) => controller?.setHeaderField(row.id, "key", e.target.value)} style={{ ...inputStyle, flex: 1, margin: 0 }} />
                <input placeholder="值（禁止换行）" value={row.value} onChange={(e) => controller?.setHeaderField(row.id, "value", e.target.value)} style={{ ...inputStyle, flex: 1, margin: 0 }} />
                <button type="button" onClick={() => controller?.removeHeader(row.id)}>删除</button>
              </div>
            ))}
            <button type="button" onClick={() => controller?.addHeader()} style={{ fontSize: 12 }}>
              + 添加请求头
            </button>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button type="button" onClick={() => void controller?.testProvider()} disabled={testing || !form.model}>
              {testing ? "测试中…" : "测试连接"}
            </button>
            <button type="submit" disabled={saving || !form.model}>
              {editingId ? "保存修改" : "添加 Provider"}
            </button>
            {editingId && (
              <button type="button" onClick={() => controller?.cancelEdit()}>取消编辑</button>
            )}
          </div>
          {formError && <div style={{ color: "#d94343", fontSize: 13 }}>{formError}</div>}
          {testResult && (
            <div style={{ fontSize: 13, color: testResult.success ? "#10a37f" : "#d94343" }}>
              {testResult.success
                ? `连接成功：${testResult.providerType} · ${testResult.model} · ${testResult.latencyMs}ms`
                : `连接失败：${testResult.error?.message ?? "未知错误"}`}
            </div>
          )}
        </form>

        <h3 style={{ fontSize: 15, marginTop: 20 }}>已配置 Provider</h3>
        {providers.length === 0 ? (
          <p style={{ fontSize: 13, color: "#999" }}>尚未配置 Provider</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0 }}>
            {providers.map((p) => (
              <li
                key={p.id}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid #eee", fontSize: 13 }}
              >
                <span style={{ flex: 1 }}>
                  {p.name}（{p.type} · {p.model}）
                  {p.enabled ? "" : " · 已禁用"}
                  {p.disableThinking ? " · 非思考模式" : ""}
                  {/* 已保存 Key 只显示"已配置"，绝不含 Key 明文。 */}
                  {p.apiKeyConfigured ? " · 已配置" : " · 无 Key"}
                  {isDefaultProvider(p.id, activeProviderId) && <span style={{ color: "#10a37f" }}> ✓ 默认</span>}
                </span>
                <button type="button" onClick={() => void controller?.setDefault(p.id)}>设为默认</button>
                <button type="button" onClick={() => controller?.editProvider(p)}>编辑</button>
                <button type="button" onClick={() => void controller?.removeProvider(p.id)}>删除</button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>隐私与数据流</h2>
        <ol style={{ fontSize: 13 }}>
          <li>ChatGPT 当前输入框 → Prompt Boost 浏览器扩展 → 本机本地服务 → 你配置的 AI API</li>
          <li>只有点击 Boost 后才读取输入框；默认不监听键盘输入。</li>
          <li>不读取历史对话、Cookie 或登录令牌；不自动发送消息。</li>
          <li>Prompt 只发往你配置的 Provider，不会上传到 Prompt Boost 服务器。</li>
          <li>API Key 由本机 local-agent 加密保存（Vault），绝不写入扩展存储或响应体。</li>
        </ol>
      </section>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  padding: "8px 10px",
  margin: "4px 0 10px",
  border: "1px solid #ddd",
  borderRadius: 6,
  fontSize: 13,
};

createRoot(document.getElementById("root")!).render(<Options />);
