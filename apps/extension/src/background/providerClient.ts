/**
 * 背景页 Provider 管理：Options → background → local-agent。
 *
 * API Key 生命周期：
 * - Key 由用户在 Options 输入，经 background 转发到 local-agent 的
 *   POST/PUT /v1/providers，由 Vault 加密保存。
 * - background / chrome.storage / content 均不保存完整 Key。
 * - Key 绝不进入 chrome.storage.local（扩展设置只存非敏感配置）。
 */
import type {
  ProviderConfig,
  ProviderModelsResult,
  ProviderSummary,
  ConnectionTestResult,
} from "@prompt-boost/shared";
import { getExtensionSettings, getLocalAgentToken } from "./settings.js";
import { clientOptionsFrom, requestLocalAgent } from "./localAgentClient.js";

async function auth() {
  const [settings, token] = await Promise.all([getExtensionSettings(), getLocalAgentToken()]);
  return { token, opts: clientOptionsFrom(settings, token) };
}

export interface ProviderListResult {
  providers: ProviderSummary[];
  /** 当前默认 Provider（local-agent settings 持久化）。 */
  activeProviderId: string | null;
}

/** 列表 Provider 摘要（不含 Key）。返回默认 Provider 标记供 Options 页展示。 */
export async function listProvidersFromAgent(): Promise<ProviderListResult> {
  const { token, opts } = await auth();
  const res = await requestLocalAgent(opts, {
    path: "/v1/providers",
    method: "GET",
    token,
  });
  if (!res.ok) throw new Error(res.message);
  const data = res.data as { providers: ProviderSummary[]; activeProviderId?: string | null };
  return {
    providers: data.providers,
    activeProviderId: data.activeProviderId ?? null,
  };
}

/** 保存 Provider（新建/更新）。apiKey 可选：不传则不覆盖已存 Key。 */
export async function saveProviderToAgent(
  config: ProviderConfig,
  apiKey?: string,
): Promise<ProviderSummary> {
  const { token, opts } = await auth();
  // id 已在 URL path 中；服务端 zProviderUpdateRequest 是 strict schema（无 id 字段），
  // 发送前剥离 id，否则 PUT 被 zod 拒绝（编辑已有 Provider 必失败）。
  const { id: _id, ...configWithoutId } = config;
  const res = await requestLocalAgent(opts, {
    path: `/v1/providers/${encodeURIComponent(config.id)}`,
    method: "PUT",
    token,
    body: { ...configWithoutId, apiKey },
  });
  if (!res.ok) throw new Error(res.message);
  const data = res.data as { provider: ProviderSummary };
  return data.provider;
}

/** 新建 Provider。 */
export async function createProviderToAgent(
  config: ProviderConfig,
  apiKey?: string,
): Promise<ProviderSummary> {
  const { token, opts } = await auth();
  const res = await requestLocalAgent(opts, {
    path: "/v1/providers",
    method: "POST",
    token,
    body: { config, apiKey },
  });
  if (!res.ok) throw new Error(res.message);
  const data = res.data as { provider: ProviderSummary };
  return data.provider;
}

/** 删除 Provider（连同 Vault 密钥）。 */
export async function deleteProviderFromAgent(id: string): Promise<void> {
  const { token, opts } = await auth();
  const res = await requestLocalAgent(opts, {
    path: `/v1/providers/${encodeURIComponent(id)}`,
    method: "DELETE",
    token,
  });
  if (!res.ok) throw new Error(res.message);
}

/** 连接测试（新建未保存配置，或已保存配置按 Key）。 */
export async function testProviderConnection(
  config: ProviderConfig,
  apiKey?: string,
): Promise<ConnectionTestResult> {
  const { token, opts } = await auth();
  const res = await requestLocalAgent(opts, {
    path: "/v1/providers/test",
    method: "POST",
    token,
    body: { config, apiKey },
  });
  if (!res.ok) throw new Error(res.message);
  return res.data as ConnectionTestResult;
}

/** 拉取可用模型列表。apiKey 留空时服务端从 Vault 读（编辑已保存 Provider）。 */
export async function listModelsFromAgent(
  config: ProviderConfig,
  apiKey?: string,
): Promise<ProviderModelsResult> {
  const { token, opts } = await auth();
  const res = await requestLocalAgent(opts, {
    path: "/v1/providers/models",
    method: "POST",
    token,
    body: { config, apiKey },
  });
  if (!res.ok) throw new Error(res.message);
  // 服务端在无 Key / 上游失败时返回 HTTP 200 + 体内 error；此处上抛以便前端展示安全消息。
  const data = res.data as ProviderModelsResult & { error?: { code?: string; message?: string } };
  if (data.error) {
    throw new Error(data.error.message ?? "获取模型列表失败");
  }
  return data;
}

/** 设为默认 Provider。 */
export async function setDefaultProviderToAgent(id: string): Promise<void> {
  const { token, opts } = await auth();
  const res = await requestLocalAgent(opts, {
    path: `/v1/providers/${encodeURIComponent(id)}/set-default`,
    method: "POST",
    token,
  });
  if (!res.ok) throw new Error(res.message);
}
