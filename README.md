# Prompt Boost

> 一个运行在 ChatGPT 输入框旁边的 AI Prompt 增强插件。输入原始需求，点击 **Boost**，由你自己配置的 AI API 分析、补充、润色，再把优化后的 Prompt 写回输入框——不自动发送。

## ✨ 核心特性

- 一键增强：读取当前输入 → 分析 → 优化 → 写回 → 可撤销
- 五层 Prompt Engine：分类 → 评分 → 追问规划 → 增强 → 校验
- 三档增强模式：快速 / 深度（默认）/ 专家
- 自动追问：smart（默认）/ always / off
- Prompt 质量评分：八维度加权计算，0–100
- BYOK：你自己的 OpenAI / Anthropic / OpenAI-compatible API Key，Prompt 只发往你配置的服务
- 本地服务托管密钥（系统凭证库），Key 不落扩展

## 📦 环境要求

- Node.js ≥ 22.19
- pnpm ≥ 9
- Chrome ≥ 120

## 🚀 安装与开发

```bash
git clone <repo-url> prompt-boost
cd prompt-boost
corepack enable pnpm
pnpm install
pnpm check        # lint + typecheck + test + build
```

### 加载 Chrome 扩展

```bash
pnpm --filter @prompt-boost/extension build
```

1. Chrome 打开 `chrome://extensions`
2. 开启「开发者模式」→「加载已解压的扩展程序」
3. 选择 `apps/extension/dist`
4. 打开 `https://chatgpt.com`，输入框旁出现 `✨ Boost`

### 启动本地服务

```bash
pnpm build
pnpm agent:start        # 等效于 pnpm --filter @prompt-boost/local-agent start
```

默认监听 `http://127.0.0.1:8787`（仅 loopback）。健康检查：

```bash
curl http://127.0.0.1:8787/health
```

> 启动日志只显示脱敏令牌（`Local auth token loaded: pb_****xxxx`）。
> 完整令牌通过主动命令查看：`pnpm agent:token:show`（如需轮换：`pnpm agent:token:rotate`，旧令牌立即失效）。

### API 配置

打开扩展 Options 页（右键扩展图标 → 选项）：

1. 运行 `pnpm agent:token:show` 获取本机令牌，粘贴到「本机令牌」输入框
2. 新增 Provider：类型、Base URL、API Key、Model、超时；DeepSeek 兼容网关可开启「非思考模式」
3. 点击「测试连接」（测试连接与保存是两个独立动作；API Key 只写入本机安全存储）

## 📁 仓库结构

```
apps/
  extension/     # Chrome MV3 扩展（content / background / popup / options / platform）
  local-agent/   # 本地 Express 服务（api / providers / prompt-engine / security / storage）
packages/
  shared/        # 类型、Zod schema、消息契约、常量
  prompt-core/   # 纯逻辑：任务分类、评分计算
docs/            # PRD / ARCHITECTURE / SECURITY / DOM-ADAPTER / DEVELOPMENT
```

## ❓ 常见问题

**Q: Boost 按钮没有出现？**
A: 确认访问的是 `chatgpt.com` 或 `chat.openai.com`；等待输入框加载完成（后台会自动重试最多 10 次）；刷新页面。

**Q: 点击 Boost 后提示"本地服务未连接"？**
A: 启动 local-agent，并在 Options 页填写正确令牌。

**Q: 我的 API Key 会被上传到别的地方吗？**
A: 不会。Key 只存于本机（系统凭证库），请求只发往你配置的 Base URL。见 `docs/SECURITY.md`。

**Q: 增强会覆盖我的原文吗？**
A: 不会。Boost 保存原文快照，写回后可点「撤销」恢复；若你在请求期间修改了输入框，会弹出覆盖确认。

## 🗺️ 开发进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 0 | monorepo 初始化 + 文档 + CI 检查命令 | ✅ 已完成 |
| 1 | MV3 骨架 + content/background/popup/options + ChatGPT 输入框检测 + Boost 按钮注入 | ✅ 已完成 |
| 2 | 输入框读写 + 撤销 + React 事件 | ✅ 已完成 |
| 3 | 本地服务 /health + 认证 + Zod + Provider 配置骨架 + 离线评分 | ✅ 已完成 |
| 4 | Provider 系统（真实模型调用 + Vault 密钥托管） | ✅ 已完成 |
| 5 | Prompt Engine 分析增强（单次调用闭环） | ✅ 已完成 |
| 6 | 二级菜单（增强模式 / 任务类型 / 评分 / 自动追问 / API 设置） | ✅ 已完成 |
| 7 | 自动追问（服务端产题 + 三按钮闭环） | ✅ 已完成 |
| 8 | 测试与加固（隔离 Smoke Test / 手工清单 / 安装脚本） | ✅ 已完成 |

> **MVP 状态：已完成 / 可个人使用。** 见下方「个人使用安装」。

### 模块完成度（如实标注）

| 模块 | 状态 |
| --- | --- |
| Monorepo 与构建链 | ✅ 已完成 |
| ChatGPT Adapter 单元测试（含 5 级降级级联） | ✅ 已完成 |
| 本地服务实机验证（HTTP /health /v1/analyze /v1/enhance） | ✅ 已完成 |
| 扩展与本地服务消息链 | ✅ 已完成（content → background → local-agent） |
| Provider 真实模型调用 | ✅ 已完成（OpenAI / Anthropic / OpenAI-compatible，Vault 托管 Key） |
| Prompt 增强写回 | ✅ 已完成（单次调用闭环 + 撤销 + 冲突保护） |
| 自动追问 | ✅ 已完成（服务端产题 ≤3 + 取消/默认假设/回答并增强） |
| 真实 ChatGPT 页面手工冒烟 | ⏳ 待手工验证（见 `docs/CHATGPT-MANUAL-SMOKE.md`） |

### 验证等级说明

```text
自动测试：
由 Vitest、jsdom 或本地 fixture 验证。

本地实机验证：
实际启动 Local Agent 并通过 HTTP 请求验证。

网页手工验证：
在真实 chatgpt.com 页面加载扩展并人工检查。
```

> 说明：自动测试（Vitest / jsdom fixture）+ 本地实机验证（真实启动 local-agent 的 HTTP 闭环）已全部通过（`pnpm check` + `smoke-test-final.mjs` 隔离 Smoke Test）。真实 chatgpt.com 页面仍属人工验证，清单见 `docs/CHATGPT-MANUAL-SMOKE.md`。

## 👤 个人使用安装（Windows）

以下步骤只在本机执行一次，不涉及商店发布 / 云同步。

1. **准备**：安装 [Node.js](https://nodejs.org/) ≥ 22.19 与 [pnpm](https://pnpm.io/) ≥ 9（或 `corepack enable pnpm`）。
2. **构建**：在本仓库根目录运行
   ```bash
   pnpm install
   pnpm build
   ```
3. **加载扩展**：Chrome 打开 `chrome://extensions` → 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `apps/extension/dist`。
4. **启动本地服务**：双击 `scripts\start-prompt-boost.cmd`（等效 `pnpm agent:start`，监听 `127.0.0.1:8787`）。停止：双击 `scripts\stop-prompt-boost.cmd` 或直接关闭服务窗口。
5. **配置**：右键扩展图标 →「选项」。先在终端运行 `pnpm agent:token:show` 获取本机令牌并粘贴到「本机令牌」；再新增 Provider（类型 / Base URL / API Key / Model / 超时）→「测试连接」→ 保存。DeepSeek V4/PackyAPI 等支持 `thinking` 参数的 OpenAI-Compatible Provider 可勾选「非思考模式」。API Key 只写入本机安全存储，Options 页始终显示「已配置」。
6. **使用**：打开 `https://chatgpt.com`，输入需求 → 点击 `✨ Boost`（或 `✨ Boost ▾` 展开菜单调整增强模式 / 自动追问 / 评分）。

> 每次电脑重启后需重新启动本地服务（第 4 步）。令牌轮换：`pnpm agent:token:rotate`。

## 📚 文档

- [产品需求 PRD](docs/PRD.md)
- [架构 ARCHITECTURE](docs/ARCHITECTURE.md)
- [安全 SECURITY](docs/SECURITY.md)
- [ChatGPT DOM 适配 DOM-ADAPTER](docs/DOM-ADAPTER.md)
- [开发 DEVELOPMENT](docs/DEVELOPMENT.md)
- [最终范围审计 FINAL-SCOPE-AUDIT](docs/FINAL-SCOPE-AUDIT.md)
- [真实页面手工冒烟清单 CHATGPT-MANUAL-SMOKE](docs/CHATGPT-MANUAL-SMOKE.md)
