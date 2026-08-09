# 连接失败误报修复报告（"无法连接本地服务"）

## 现象

扩展报"增强失败：无法连接本地服务：请确认 Prompt Boost 本地服务已启动（127.0.0.1:8787）"。

## 审计结论（以代码 + 实测为准）

**服务其实一直活着。** 逐项排除：

| 排查项 | 结果 | 证据 |
|---|---|---|
| 本地服务进程 | ✅ 正常 | `/health` 200 |
| 认证令牌 | ✅ 正常 | 错误 token 24ms 内 401，正确 token 正常放行 |
| API Key | ✅ 有效 | `/v1/providers/packyapi/test` → `success:true`（1350ms） |
| `/v1/enhance` 真实调用 | ⚠️ **需 ~19.6s** | `curl -m 70` 实测 19.57s 返回成功 |
| 扩展 background fetch 超时 | ❌ **15s** | `localAgentClient.ts` `DEFAULT_TIMEOUT_MS = 15_000` |

**根因链：** `/v1/enhance` 一次真实 LLM 生成约需 20 秒（非流式完整 JSON，含分类+评分+追问+增强+8 维评分，耗时为中继网关模型生成时间）。扩展 `handleBoostEnhance` 调用 `requestLocalAgent` 时**没传 `timeoutMs`**，落到 15 秒默认值。15 秒一到，`AbortSignal.timeout` 中止 fetch，代码把 AbortError 误判为 network 错误，返回"无法连接本地服务"。

即：**服务端在处理、在正常生成，只是响应慢于 15 秒被客户端截断，还被报成了"服务没启动"。** 且服务端 60 秒 Provider 超时被架空，每次都是客户端 15s 先断、服务端白白烧完一次上游调用。

## 修复内容

### 1. 超时分层补齐（核心）

- [background.ts](apps/extension/src/background/background.ts) `handleBoostEnhance` 显式传 `timeoutMs: ENHANCE_TIMEOUT_MS`（90s），慢但正常的生成不再被截断。
- [localAgentClient.ts](apps/extension/src/background/localAgentClient.ts) 新增 `ENHANCE_TIMEOUT_MS = 90_000` 导出，并手动合并内部超时信号与外部中止信号（`combineSignals`，不依赖 jsdom/旧 Node 缺失的 `AbortSignal.any`）。
- [server.ts](apps/local-agent/src/server.ts) 增加 `server.timeout = 120_000` 兜底：任何请求（含 socket 悬空）最多 120s，慢 Provider 无法挂死连接常驻。

### 2. 错误码拆分（消除误导）

- [messages.ts](packages/shared/src/messages.ts) 新增 `LocalAgentErrorCode.Timeout = "timeout"`。
- [localAgentClient.ts](apps/extension/src/background/localAgentClient.ts) 把 **AbortError/TimeoutError → Timeout**（"服务生成较慢，请稍候再试"）与 **TypeError（连接拒绝）→ Network**（原"无法连接本地服务"文案）分开判定，不再混为一谈。
- [controller.ts](apps/extension/src/content/controller.ts) `mapErrorMessage` 增加 `"timeout"` 分支（"服务生成较慢，请稍候再试"）。真实断网/服务未启动仍显示"请确认本地服务已启动"，现在文案与实际一致。

### 3. 断连中止孤儿请求（防白烧额度）

- [app.ts](apps/local-agent/src/app.ts) `/v1/enhance` 路由用 `res.on("close")` + `!res.writableEnded` 检测客户端断连 → `AbortController` 中止上游调用。
- 信号经 `promptEngine.enhance(req, signal)` → `runEnhance(deps.signal)` → `provider.enhancePrompt(req, { signal })` → `chatOnce` → `postJson(opts.signal)` 全链路透传，客户端断开即中止上游 fetch，不再让孤儿请求继续消耗额度。`mapNetworkError` 已把 AbortError 安全映射为 TIMEOUT（retryable）。

> 实现陷阱：不能监听 `req.on("close")`——Node 中它表示请求体读取完成，不是断连，会导致请求被提前误中止（首次实现即踩中）。

## 验证

| 项 | 结果 |
|---|---|
| shared 构建 + 类型检查 | ✅ |
| local-agent 类型检查 + 构建 | ✅ |
| local-agent 测试 | ✅ 121 通过（含新增 2 个断连中止集成测试） |
| extension 类型检查 + 构建 | ✅ |
| extension 测试 | ✅ 111 通过（含新增 2 个超时映射单元测试） |
| 冒烟测试（隔离 temp dirs） | ✅ 全部通过，真实 `data/` hash+mtime 前后一致 |

**新增测试：**
- [localAgentClient.test.ts](apps/extension/src/background/localAgentClient.test.ts)：AbortError → Timeout（非 Network）；外部 `requestAbortSignal` 中止 → Timeout。
- [app-disconnect.test.ts](apps/local-agent/tests/app-disconnect.test.ts)：真实 HTTP 断连后上游 LLM 调用被中止；正常完成时不被误中止（对照）。

## 用户可见行为变化

- 慢生成（>15s）不再报"无法连接本地服务"；90s 内返回的增强能正常完成。
- 若确实超时（>90s），报"服务生成较慢，请稍候再试"，与事实一致。
- 真正没启动服务时，仍立即报"请确认本地服务已启动"（<1s）。
