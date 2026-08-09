# Prompt Boost — Security

> Version 0.1.0 · MVP scope

## 1. 权限说明

Manifest V3 只申请必要权限：

```json
{
  "permissions": ["storage"],
  "host_permissions": [
    "https://chatgpt.com/*",
    "https://chat.openai.com/*",
    "http://127.0.0.1:8787/*"
  ]
}
```

不申请：`tabs`、`history`、`cookies`、`webRequest`、`browsingData`、`clipboardRead`、`<all_urls>`。

> 规则：如确需新增权限，必须先在本文档说明原因并更新此节。

## 2. API Key 存储方案

### 原则

API Key **不得**：

- 写入 Git 仓库；
- 写死在前端代码 / content script；
- 写入日志；
- 发送给 ChatGPT 页面；
- 注入页面 DOM；
- 明文存储于 SQLite 或普通配置文件；
- 由 content script 直接读取。

### 生产方案（优先级）

本地服务使用系统凭证库：

- Windows：Windows Credential Manager（`wincred`）
- macOS：Keychain（`keytar` / `security`）
- Linux：Secret Service（libsecret）

> 采用可选依赖 `keytar` 并隔离在 `security/vault.ts`。安装与系统后端探测成功时使用系统凭证库；否则回退到下面的加密文件模式。首次切换成功会迁移旧文件 Vault，并在确认写入系统凭证库后移除旧密文副本。

### 开发模式回退（加密文件存储）

当系统凭证库不可用时，本地服务启用 **加密文件存储**（`data/vault.enc.json`）：

- 密钥派生：`PBKDF2(secret, salt, 210k iter, sha256)`。
- 密钥源：环境变量 `LOCAL_AGENT_VAULT_KEY`，否则首次启动生成随机密钥写入 `data/.vault-master-key`（chmod 0600，仅在开发模式创建）。
- 加密算法：AES-256-GCM，带随机 IV。
- 明文永不落盘；删除密钥文件即可作废所有密钥。
- 敏感自定义 Header（Authorization、x-api-key、token 等）与 API Key 一样只存 Vault；SQLite 仅保存 `***` 占位。旧版本明文会在服务启动时全量迁移并执行 WAL checkpoint/VACUUM。
- Windows 不依赖无效的 `0600` 语义：运行时数据目录、Vault、令牌和 SQLite/WAL/SHM 都通过 `icacls` 移除继承，仅授权当前用户。

> **明确标注**：该模式为**开发模式**。生产发布必须切换到系统凭证库。
> `vault.ts` 的 `VaultMode` 为 `"system" | "file"`，启动日志中明确打印当前模式。

### 扩展保存的内容（不含 Key）

Chrome 扩展 `chrome.storage` 只保存：

- provider ID、模型名称、base URL、API 类型；
- 用户偏好（增强模式、追问模式、任务类型）；
- 本地服务连接状态、本机令牌（`LOCAL_AGENT_TOKEN`）。

**扩展不保存完整 API Key。**

## 3. 本地认证方案

- 服务只监听 `127.0.0.1:8787`。
- 首次启动生成 32 字节随机令牌（hex）写入 `data/.auth-token`（0600）。
- 除 `/health` 外的所有接口要求 `Authorization: Bearer <token>`。
- Origin 校验：仅接受 `chrome-extension://*` 与 `http://localhost*`（开发）。
- 扩展 Options 页保存本机令牌后，Background 在请求头附带。
- 环境变量 `LOCAL_AGENT_AUTH_TOKEN` 可显式固定令牌（仅开发/测试）。

### 令牌输出安全

- **启动日志只打印脱敏令牌**（`Local auth token loaded: pb_****xxxx`），完整令牌不再出现在普通日志。
- 完整令牌仅通过主动命令获取：
  - `pnpm agent:token:show` — 只在用户主动执行时输出完整令牌，输出带敏感提示，直接写 stdout（不经日志脱敏管道，属有意为之），不写入日志文件。
  - `pnpm agent:token:rotate` — 生成新令牌并持久化；旧令牌立即失效，扩展需重新配置；不影响 Provider API Key。
- 令牌文件 `data/.auth-token` 以 `0600` 权限落盘，位于 git 忽略的 `data/` 目录，不进入项目目录根、不提交 Git。
- 令牌不会出现在任何 HTTP 响应体中。

### 接口示例

`POST /v1/analyze`（Prompt 只出现在请求体，绝不进入查询参数，避免出现在 URL / 代理日志 / 浏览器历史）：

```http
POST /v1/analyze HTTP/1.1
Host: 127.0.0.1:8787
Content-Type: application/json
Authorization: Bearer <local-token>

{
  "originalText": "帮我写一个产品推广方案",
  "taskType": "auto",
  "enhanceLevel": "deep",
  "clarificationMode": "smart"
}
```

> GET `/v1/analyze?text=…` 已禁用（返回 404）。

## 4. 威胁模型

| 威胁 | 缓解 |
| --- | --- |
| 本机其他进程扫描 API Key | 系统凭证库 / 加密文件（0600）；不落明文日志 |
| 恶意网页调用本地服务 | 仅监听 loopback + Bearer 令牌 + Origin 校验 + CORS 白名单 |
| 扩展被注入恶意脚本窃取 Key | content script 不接触 Key；Key 只在 local-agent 内存中使用 |
| 日志泄露 Prompt / Key | 默认不记录请求体；`LOG_VERBOSE=true` 仅开发；日志层强制 Key 脱敏 |
| 中间人截获扩展↔服务流量 | 开发期 HTTP+令牌（loopback）；生产文档说明可切换 HTTPS |
| Provider 返回恶意内容 | 所有返回值经 Zod 校验；增强结果仅作文本写回，不执行 |
| 请求体过大/慢请求 | 体大小限制 + 超时 |
| 无限重试 / 无限追问 | 追问 ≤ 3 题/轮；JSON 修复 ≤ 1 次 |

## 5. 日志脱敏

- 日志层统一 `redact()`：匹配 `sk-…`、`Bearer …`、长 hex/base64 片段等模式替换为 `[REDACTED]`。
- 默认不打印 Prompt 内容；仅打印长度、requestId、耗时、状态码。
- `LOG_VERBOSE=true` 时打印完整请求体，仅限本地开发，且打印前同样经过 Key 脱敏。
- **完整本地认证令牌不会出现在任何日志中**；启动日志只显示脱敏形式（`pb_****xxxx`）。完整令牌仅通过 `pnpm agent:token:show` 主动查看。

## 6. 已知风险

1. **`better-sqlite3` 原生模块**：构建环境需与 Node ABI 匹配；打包分发时按目标 Node 版本构建。MVP 阶段数据库仅存 Provider 配置元数据（不含 Key），影响面有限。
2. **`keytar` 系统凭证依赖**：若编译或运行时不可用，自动降级加密文件模式；Options 页展示当前存储模式。
3. **Vite 多入口构建**：需确认各 chunk 的 CSP 合规（MV3 无 `unsafe-eval`）。我们通过不使用动态 `eval` 并生成无内联脚本的产物规避。
4. **ChatGPT DOM 变更**：适配器依赖语义属性与位置锚点，仍可能被上游改版破坏；见 `docs/DOM-ADAPTER.md` 的降级策略。
5. **内网代理**：部分企业网络会拦截扩展对 127.0.0.1 的请求；无通用解法，属已知限制。

## 7. 生产加固清单（非 MVP，发布前）

- [ ] 系统凭证库启用与验证
- [ ] HTTPS + 自签证书或 Windows Loopback 豁免说明
- [ ] 扩展签名与商店合规审查
- [ ] 依赖供应链审计（`pnpm audit`）
