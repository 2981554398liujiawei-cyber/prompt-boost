# Prompt Boost — Development

> 版本 0.1.0 · MVP

## 1. 环境要求

- Node.js ≥ 22.19（开发使用 Node 24）。
- pnpm ≥ 9（`corepack enable pnpm`）。
- Chrome ≥ 120（Manifest V3）。

## 2. 常用命令

```bash
pnpm install        # 安装依赖（workspace）
pnpm lint           # ESLint
pnpm typecheck      # tsc --noEmit
pnpm test:run       # Vitest（单次运行）
pnpm build          # 构建全部包
pnpm check          # lint + typecheck + test + build 一次性执行
```

单包执行：`pnpm --filter @prompt-boost/extension lint`。

## 3. 本地开发流程

### 3.1 启动本地服务

```bash
pnpm --filter @prompt-boost/local-agent dev
# 默认监听 http://127.0.0.1:8787
curl http://127.0.0.1:8787/health
```

### 3.2 加载扩展（临时加载）

1. `pnpm --filter @prompt-boost/extension build`（或 `dev`）。
2. Chrome 打开 `chrome://extensions`。
3. 开启「开发者模式」→「加载已解压的扩展程序」→ 选择 `apps/extension/dist`。
4. 打开 `https://chatgpt.com`，输入框旁出现 `✨ Boost`。

### 3.3 连接本地服务

1. 启动本地服务：`pnpm agent:start`（启动日志只显示脱敏令牌）。
2. 获取完整令牌：`pnpm agent:token:show`（或轮换：`pnpm agent:token:rotate`）。
3. 打开扩展 Options 页（右键扩展图标 → 选项），在「本地服务」粘贴令牌，点击「测试连接」。

## 4. API 配置

在 Options 页新增 Provider：

- Provider 类型：openai / anthropic / openai-compatible
- API Base URL、API Key、Model 名称、超时（秒）
- OpenAI-Compatible 可选「非思考模式」；开启时请求带 `thinking: { type: "disabled" }`
- 点击「测试连接」验证

API Key 由本地服务写入系统凭证库（或开发模式加密文件），扩展不保存。

## 5. 测试流程

- 单测：`pnpm test:run`（评分计算、任务分类、schema、错误转换、设置默认值等）。
- 集成（后续阶段）：Local Agent ↔ Mock Provider。
- E2E（后续阶段）：Playwright + 本地 Composer fixture，覆盖 textarea / contenteditable / DOM 重渲染 / 路由切换 / 深色模式。
- 线上 ChatGPT 仅用于**手工冒烟**，不进入自动化。

## 6. 分支与提交

- `main` 仅合并已通过 `pnpm check` 的分支。
- 分支命名：`feat/`、`fix/`、`chore/`。
- 提交信息：中文即可，遵循 Conventional Commits 结构（`feat:` / `fix:` / `docs:` / `chore:`）。
- 不执行自动 push；发布由人工触发。

## 7. 调试方法

- Content Script：在 ChatGPT 页面打开 DevTools，查找 `content script` 的 console；`console.debug` 标记 `[prompt-boost]`。
- Background：在 `chrome://extensions` 该扩展卡片点击「Service Worker」。
- Local Agent：终端查看日志；`LOG_VERBOSE=true` 打印请求体（仅开发）。
- 构建产物检查：`apps/extension/dist/manifest.json` 核对权限与 CSP。

## 8. 发布流程（占位，后续完善）

1. `pnpm check` 全绿。
2. 更新 `docs/PRD.md` 状态表、README 进度、版本号。
3. 构建并手工冒烟（线上 ChatGPT）。
4. 打包 zip → 人工上传 Chrome Web Store（不自动执行）。
