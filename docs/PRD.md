# Prompt Boost — Product Requirements Document (PRD)

> Version 0.1.0 · MVP scope · Status: Draft

## 1. 产品目标

Prompt Boost 是一个运行在 ChatGPT 网页输入框旁边的 AI Prompt 增强插件。

用户输入原始需求后，点击一个简洁的 **Boost** 按钮，由用户自行配置的 AI API 对文本进行分析、补充和润色，再将结果写回 ChatGPT 输入框。插件**不自动发送**消息。

示例：

```text
用户输入：帮我写一个产品推广方案
优化结果：你是一名资深 SaaS 产品营销顾问。请为一款面向中小企业的项目管理软件
制定产品推广方案。方案需要包含：1. 目标用户画像 2. 产品核心卖点 3. 推广渠道
4. 内容营销策略 5. 30 天执行计划 6. 预算建议 7. 效果衡量指标。请使用结构化
标题和表格输出，并优先提供低成本、可快速验证的推广方案。
```

## 2. 用户画像

- **主力用户**：重度使用 ChatGPT 且对 Prompt 质量有要求的个人用户、开发者、营销人员。
- **特征**：希望用更少的往返次数得到更好的结果；会为 AI API 付费（BYOK）；对隐私敏感，不希望 Prompt 上传到第三方服务器。
- **非目标**：企业团队管理、Prompt 市场、账号体系用户。

## 3. 用户故事

| 编号 | 用户故事 |
| --- | --- |
| US-1 | 作为用户，我希望在输入框旁一键提升 Prompt 质量，而不需要手动粘贴到别处。 |
| US-2 | 作为用户，我希望插件能自动识别我的任务类型并采用对应增强策略。 |
| US-3 | 作为用户，我希望在信息不足时被追问最关键的几个问题，而不是收到泛泛的优化。 |
| US-4 | 作为用户，我希望增强结果能写回输入框并可撤销，防止意外丢失原文。 |
| US-5 | 作为用户，我希望用我自己的 API Key（BYOK），数据只发往我配置的 Provider。 |
| US-6 | 作为用户，我希望了解当前 Prompt 的质量评分和缺失项，从而持续改进写法。 |
| US-7 | 作为用户，我希望界面保持简洁，二级功能收进菜单，不占用输入框空间。 |

## 4. 功能范围（MVP）

### 4.1 支持平台

- `https://chatgpt.com/*`（主）
- `https://chat.openai.com/*`（兼容旧地址）

不包含：Claude / Gemini / Perplexity / Cursor / 其他 AI 网站、手机浏览器、Firefox、Safari。

架构通过 `PlatformAdapter` 接口为未来平台预留扩展点，但当前不投入开发。

### 4.2 核心功能

1. 读取 ChatGPT 当前输入框文本（支持 textarea 与 contenteditable）。
2. 在输入框操作区旁注入 Boost 按钮（Shadow DOM 隔离）。
3. 一键增强：读取 → 分析 → （可选追问）→ 生成 → 写回 → 可撤销。
4. 二级菜单：增强模式 / 任务类型 / 自动追问 / Prompt 评分 / API 设置。
5. 五层 Prompt Engine：分类 → 分析 → 追问规划 → 增强 → 校验。
6. BYOK Provider：OpenAI、Anthropic、OpenAI-compatible。

### 4.3 二级能力（位于二级菜单，不常驻主界面）

- **Prompt 质量评分**（0–100，八维度加权，程序计算而非模型随意输出）。
- **自动识别任务类型**：writing / coding / business / analysis / research / learning / translation / planning / creative / general。
- **多级增强模式**：quick（快速）/ deep（深度，默认）/ expert（专家）。
- **自动追问机制**：off / smart（默认）/ always，最多 3 个问题，可跳过或用默认假设。

## 5. 非目标（明确不做）

- Prompt 模板市场、团队空间、企业知识库、用户账户系统、云同步、支付系统。
- Prompt 历史库、社区分享。
- 自动点击发送、读取聊天上下文、自动执行任务。
- 浏览器云端代理、多平台网页适配、移动端、Firefox/Safari。
- Prompt 效果长期学习、Agent 自动拆解并执行任务。

## 6. 安全与隐私要求

- BYOK：Prompt 只发往用户配置的 API Provider，绝不上传自有服务器。
- API Key 不写入 Git、前端代码、日志、页面 DOM、SQLite 明文；由本地服务经系统凭证库加密存储。
- 默认不监听键盘输入；只在用户点击 Boost 后读取输入框。
- 不读取历史对话、浏览器 Cookie、ChatGPT 登录令牌。
- 扩展权限最小化：仅 `storage` + 指定 host_permissions。
- 详见 `docs/SECURITY.md`。

## 7. 验收标准（MVP）

1. 打开 ChatGPT，Boost 按钮只出现一次；切换/新建会话后仍存在。
2. 深色/浅色主题均正常；不遮挡原有按钮，不改变布局。
3. 点击 Boost 后增强结果写回输入框，不自动发送，可一键撤销。
4. 三档增强结果存在明显差异，且不改变用户核心目标、不直接回答原任务。
5. Smart 追问模式对信息不足的 Prompt 最多提出 3 个问题；信息充分的 Prompt 不追问。
6. 评分由八维度加权计算，缺失项与建议可见。
7. 用户配置 Provider 后可"测试连接"成功。
8. 本地服务只监听 127.0.0.1；未授权请求被拒绝；日志不含 API Key。

## 8. 状态

| 日期 | 里程碑 | 状态 |
| --- | --- | --- |
| 2026-08-07 | 第一轮：monorepo + 扩展骨架 + 输入框读写 + /health 链路 | 进行中 |

（后续里程碑按 `docs/DEVELOPMENT.md` 的发布流程追加。）
