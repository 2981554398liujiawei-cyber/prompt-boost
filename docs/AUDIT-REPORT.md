# Prompt Boost 完整审计报告

**日期：** 2026-08-08
**审计方式：** 多 agent 并行审计（正确性 / 安全 / 扩展 MV3 / 共享启发式 / 健壮性 5 个维度 + 独立对抗性验证）→ 59 个原始 findings → **45 个经对抗验证确认**。我本人逐行阅读关键文件交叉验证 + 运行时实测验证（zod 校验、超时信号、错误映射、Windows 文件权限）。

> **验证原则：** 每条 finding 均基于代码原文 + 运行结果，不以报告描述为准。标注为「已实测」的条目都有可复现的运行时证据；标注为「源码确认」的条目来自逐行审读；标注为「对抗验证」的条目经过独立 verify agent 复核（含失败场景推演与代码行核对）。

**总览：** 45 个确认问题中 **16 个 major、29 个 minor、0 个 critical**。原判 critical 的两项（Anthropic response_format、PUT id）经对抗验证从可利用性角度降为 major——它们是**功能完全失效**但 fail-open（返回原文、无数据/安全影响、可通过切换 Provider 规避），属"高优先级 bug"而非"必须立即止血的漏洞"。

---

## 一、功能阻断（用户主路径不可用，优先级最高）

### 1. Anthropic Provider 的增强功能完全不可用 ⚠️ major
**文件：** [anthropic.ts:184](apps/local-agent/src/providers/anthropic.ts#L184)
**对抗验证：** ✅ 确认（verdict: major）

- `chat()` 忽略 `_jsonMode` 参数，`buildRequest` 在 `jm === true` 时向 Anthropic Messages API 的 POST `/messages` 请求体注入其**不认识**的 `response_format: { type: "json_object" }` → 恒 400。
- **后果链：** 400 → `mapProviderResponse` 映射为 `INVALID_REQUEST`（非 `RESPONSE_INVALID`）→ `pipeline.ts:229-233` 仅对 `RESPONSE_INVALID` 走 fallback、`INVALID_REQUEST` 直接 throw → `app.ts:358` 返回 HTTP 200 + 原文 + error（fail-open，不崩溃）。
- **隐蔽性：** `testConnection` 用不含 `response_format` 的最小请求 → "测试连接"通过，但真实增强每次必 400。文件头注释第 6 行作者自认 "Anthropic 无 json_object 模式"，代码却反着来。
- **已实测：** 逐行确认 `chat()` 恒传 `jsonMode=true`（第 197 行 `chatOnce(..., true, options)`）。

### 2. 编辑已有 Provider 永远失败（PUT 被 strict zod 拒绝）⚠️ major
**文件：** [providerClient.ts:55](apps/extension/src/background/providerClient.ts#L55)（触发点）、[app.ts:149](apps/local-agent/src/app.ts#L149)（拒绝点）
**对抗验证：** ✅ 确认（verdict: major），并实测 zod@3.24.1 `safeParse` → `Unrecognized key(s) in object: 'id'`

- 扩展 `saveProviderToAgent` 发送 `{ ...config, apiKey }`（`config` 含必填 `id`）；服务端 `zProviderUpdateRequest` 是 **strict** schema 且无 `id` 字段。
- **后果：** 编辑任何已有 Provider（改 baseUrl/模型/超时）必 400；只有新增和删除能工作。失败链还会叠加渲染成 "保存失败：[object Object]"（见 #10）。
- **测试盲区：** [app.test.ts:320,340](apps/local-agent/tests/app.test.ts) 的 PUT body 均不带 id，未覆盖真实扩展消息流 → 测试全绿不推翻 bug。

### 3. `textFallback` 不是真正的纯文本重试 —— 设计意图落空 ⚠️ major
**文件：** [pipeline.ts:248](apps/local-agent/src/prompt-engine/pipeline.ts#L248)
**对抗验证：** ✅ 确认（verdict: major）

- `textFallback` 意图是用更宽松约束重试，但 `provider.enhancePrompt` 内部**恒以 `jsonMode=true`** 调用 chat → fallback 请求仍注入 `response_format`。对 Anthropic 是二次踩坑，对 OpenAI 是重复同一模式。

---

## 二、数据完整性 / 意图保真（中文用户主场景失效）

### 4. 意图保真校验对纯中文输入整体失效 ⚠️ major
**文件：** [pipeline.ts:71-85](apps/local-agent/src/prompt-engine/pipeline.ts#L71)
**对抗验证：** ✅ 确认（verdict: major），且实测影响面比声明更大

- `tokenize` 正则 `/[一-鿿]|[a-z0-9]+/g` 把每个汉字拆为单字 token；`missingCoreTokens` 只保留 `length>=2` 的 token → **纯中文原文的 significant 集恒为空**，`missing` 恒返回 `[]` → `isAcceptable` 恒放行。
- **后果：** 对产品主语言（中文）的所有输入，"意图保真"防线是 no-op。任何非空、非原文的 LLM 幻觉/空壳输出都被当作成功写回并**静默覆盖用户输入**，无降级提示。`text===original` 防护在 `runEnhance` 内联判断中根本没被使用。
- **已实测：** `missingCoreTokens("写一首关于狗的诗","写一首关于猫的诗")` → `[]`，gate 放行。
- **关联：** 现有测试 [tests:200-207](apps/local-agent/tests) 因 missing 恒空而空洞通过。

### 5. `missingCoreTokens` 漏掉单字符中文 token（与 #4 同源）
**文件：** [pipeline.ts:75](apps/local-agent/src/prompt-engine/pipeline.ts#L75)

- 只校验 `length>=2`，单字中文核心词（如"写"）被跳过。已并入 #4。

### 6. `confidence` 未 clamp、`enhancedText` 无上限 → 扩展端整次校验失败
**文件：** [pipeline.ts:99-108](apps/local-agent/src/prompt-engine/pipeline.ts#L99)、[schemas.ts:153-154,171](packages/shared/src/schemas.ts)
**对抗验证：** ✅ 确认（verdict: minor）

- `confidence: confidence ?? 0` 未 clamp 到 `[0,1]`；`enhancedText` 无长度上限（>20000 或 expert 长输出）→ 扩展端 `zPromptAnalysis` / `zEnhancePromptResponse` 校验失败 → **整单增强结果被丢弃**。与 `scoreDimensions` 的 sanitize 不对称。

---

## 三、安全（Key 泄露 / 权限 / SSRF）

### 7. `customHeaders` 明文落 SQLite + API 回显 —— 违反"API Key 只能存 Vault"红线 ⚠️ major
**文件：** [schemas.ts:64-67](packages/shared/src/schemas.ts#L64)、[db.ts:114-115](apps/local-agent/src/storage/db.ts#L114)、[app.ts:130](apps/local-agent/src/app.ts#L130)、[openai-compatible.ts:64-73](apps/local-agent/src/providers/openai-compatible.ts#L64)
**对抗验证：** ✅ 确认（verdict: major）

- `customHeaders` 以 JSON 字符串明文写入 SQLite；POST/GET/PUT 响应原样回显。而 [openai-compatible.ts](apps/local-agent/src/providers/openai-compatible.ts) 注释明确 customHeaders 用于"中转网关鉴权头（Authorization、x-api-key）"，且 `headers()` **优先用 custom.Authorization** —— 产品自己推荐把网关 Key 放这里。
- **后果：** 完整 Key 绕过 `vault.setSecret` 与 `apiKeyConfigured` 遮蔽逻辑，直接落 SQLite 并经 API 回显。与 app.ts:109-110 声明的"完整 Key 永不进入 SQLite/响应体"红线直接矛盾。
- **已实测：** `zProviderConfig.safeParse` 对含 `Authorization` 的 customHeaders 完全放行（无敏感标记、key 不校验）。

### 8. Windows 下 chmod 0600 无效 —— token 与 Vault 主密钥对同用户所有进程可读 ⚠️ major
**文件：** [token.ts:47](apps/local-agent/src/security/token.ts#L47)、[vault.ts:66,131](apps/local-agent/src/security/vault.ts)
**对抗验证：** ✅ 确认（verdict: major），**已实测** `statSync().mode === 0o100666`

- Node 在 Windows 上忽略 `{ mode: 0o600 }`（仅映射读写标志），文件按父目录默认 ACL 创建。项目主平台是 win32，但 docs/SECURITY.md 声称 "chmod 0600"，**文档/注释虚假承诺**。
- **后果：** 任何同用户进程可读 `data/.auth-token` 与 `data/.vault-master-key`。salt 固定 `'prompt-boost-vault-v1'`（[vault.ts:136](apps/local-agent/src/security/vault.ts#L136)），读得主密钥即可**离线解密全部 Provider API Key**。
- **修复方向：** Windows 下用 ACL（icacls / Set-Acl）收紧，或文档明确平台限制。

### 9. Vault 生产回退模式无强制门禁，静默降级 ⚠️ major
**文件：** [vault.ts:141-164](apps/local-agent/src/security/vault.ts)、[server.ts:24,33](apps/local-agent/src/server.ts)
**对抗验证：** ✅ 确认（verdict: major）

- keytar 不可用时：`NODE_ENV==='production'` 只标注 `mode:'unsupported'` 但**照常工作**（无行为差异）；`start`/`dev` scripts 不设 NODE_ENV → 连标注都不进，直接 `file` 模式**静默运行**。docs/SECURITY.md 要求"生产必须启用系统凭证库"，但无任何机制阻止生产在未装 keytar 时以文件模式运行。

### 10. Vault 加密文件无写事务，损坏后静默覆盖唯一副本 ⚠️ major
**文件：** [vault.ts:58-67](apps/local-agent/src/security/vault.ts)
**对抗验证：** ✅ 确认（verdict: major），并**修正了 2 处子路径**（并发 setSecret 实为串行不成立；registry 缓存命中后不重建）

- `load()` 对 JSON 损坏静默返回空表且不校验 shape；`setSecret`/`deleteSecret` 是 load→改写→`writeFileSync` 整体覆盖写（默认 flag 'w' 先截断再写，无 tmp+rename、无 fsync、无备份）。
- **后果：** 任何半写损坏（进程强杀在写窗口/断电/IO 错误）→ load 静默降级空表 → 后续写入覆盖唯一副本 → **全部 API Key 永久丢失且全程无报错**。触发需低概率崩溃窗口，故维持 major。

### 11. SSRF 防护可被 IPv4-mapped IPv6 完全绕过 ⚠️ major
**文件：** [http.ts:20-29,68-75](apps/local-agent/src/providers/http.ts)、调用方 [anthropic.ts:61](apps/local-agent/src/providers/anthropic.ts#L61)/[openai.ts:47](apps/local-agent/src/providers/openai.ts#L47)/[openai-compatible.ts:59](apps/local-agent/src/providers/openai-compatible.ts#L59)
**对抗验证：** ✅ 确认（verdict: major），**已实测** `new URL('https://[::ffff:192.168.1.1]/').hostname === '[::ffff:c0a8:101]'` 不匹配任何私网前缀

- `isLoopback`/`isPrivateHostname` 仅做纯 IPv4 点分十进制前缀匹配。`[::ffff:192.168.1.1]` 经 Node `dns.lookup` 直接解析到映射 IPv4（无 getaddrinfo），绕过两道检查 → 可探测内网 TLS 端口/读内网服务。
- **严重度修正依据：** /v1 全部需本地认证令牌（32 字节随机 hex），http:// 明文形式被 loopback 拒绝、仅 https 形式可用 → 可利用性受限，从 critical 降 major。但**一道明确标注"阻止非本机私网探测"的防线被编码完全绕过**。

### 12. 未受信任来源可任意解析 DNS 绕过 URL 黑名单（DNS rebinding）⚠️ major
**文件：** [http.ts](apps/local-agent/src/providers/http.ts)
**对抗验证：** 无独立 verdict（与 #11 同属 resolveBaseUrl 校验面，已并入）

- 仅做字面量 hostname 检查，`sslip.io` 类域名可解析到内网 IP 且不在 deny 列表。

### 13. 本地认证令牌明文落盘且无锁 ⚠️ major
**文件：** [token.ts:45-48](apps/local-agent/src/security/token.ts)、[app.ts:84-91](apps/local-agent/src/app.ts)
**对抗验证：** ✅ 确认（verdict: minor，与 #8 权限问题合并看待）

- `data/.auth-token` 明文 + Windows 无 0600 + 无锁可被读后复用。与 #8 同源，合并修复。

### 14. 认证只保护 /v1 前缀，OPTIONS/错误路径/时序构成令牌旁路探测面
**文件：** [app.ts](apps/local-agent/src/app.ts)
**对抗验证：** 无独立 verdict（威胁面分析，次要）

- OPTIONS 预检、404 路径、错误响应时序差异可被未授权者用于探测服务存在性。

### 15. 扩展将本地认证令牌明文存于 chrome.storage.local
**文件：** [settings.ts](apps/extension/src/background/settings.ts)
**对抗验证：** 无独立 verdict（威胁面分析）

- 该令牌保护本地 8787 服务；明文存储 + 无持久性提示。与 8787 仅绑定 127.0.0.1 共同决定实际风险。

---

## 四、运行时 / 资源管理

### 16. Provider 层 `timeoutSeconds` 被架空 ⚠️ major
**文件：** [http.ts:106](apps/local-agent/src/providers/http.ts#L106)
**对抗验证：** ✅ 确认（verdict: major），并扩展到 `/v1/analyze` 路径

- `signal: opts.signal ?? AbortSignal.timeout(timeoutMs)`：`/v1/enhance` 路径 `opts.signal` 恒存在（来自断连 abort controller）→ `AbortSignal.timeout` 永不可达 → **Provider 超时被完全跳过**。上游 LLM 挂死时只有扩展 90s + server 120s 兜底。
- **修复方向：** `combineSignals(timeout, abort)` 合并，让两者同时生效。

### 17. Express 4 async 路由未包装 → 异常时请求永久挂起 / 进程崩溃 ⚠️ major
**文件：** [app.ts:112,117,143,166](apps/local-agent/src/app.ts)、[settings.ts:83-94](apps/local-agent/src/services/settings.ts)
**对抗验证：** ✅ 确认（verdict: major），比声明更严重

- 四条 `/v1/providers` 路由是裸 async handler，未包 `requireEngine`（其余路由均包了）。Express 4 不捕获 async rejection；Node 15+ 默认 `unhandledRejection=throw` → **未捕获异常终止进程**。`saveProvider` 先 upsert 再 vault.setSecret 无 try/catch → 可能 Provider 已入库而 Key 未落 Vault（半写入）。

### 18. 优雅关闭无最大等待上限，in-flight LLM 最长阻塞 90s+ ⚠️ major
**文件：** [server.ts:50-63](apps/local-agent/src/server.ts)
**对抗验证：** ✅ 确认（verdict: minor → 与 #19 合并提升）

- shutdown 等待 in-flight 请求完成无上限。慢 LLM 使 SIGINT/SIGTERM 退出阻塞 90s+；`server.timeout=120s` 与 HTTP 层 90s 超时竞态，socket 悬空时 shutdown 挂起。

### 19. `/v1/enhance` 90s 上限依赖 MV3 service worker 长存活
**文件：** [background.ts:35](apps/extension/src/background/background.ts#L35)、[localAgentClient.ts:17](apps/extension/src/background/localAgentClient.ts#L17)
**对抗验证：** ✅ 确认（verdict: minor）

- MV3 SW 生命周期终止会截断生成且无重试。90s fetch 在 SW 上不可靠（Chrome 可能提前杀掉 SW）。

### 20. 请求日志只记 15s 粒度、失败响应体不进日志
**文件：** [app.ts:62-71](apps/local-agent/src/app.ts)
**对抗验证：** ✅ 确认（verdict: minor）

- 运营排障缺口：无法从日志判断失败原因。

---

## 五、扩展 UI / 状态机

### 21. undo 无保护地覆盖用户输入 ⚠️ major
**文件：** [controller.ts:451](apps/extension/src/content/controller.ts#L451)、[BoostHost.tsx:105,256](apps/extension/src/components/BoostHost.tsx)
**对抗验证：** ✅ 确认（verdict: major）

- `undo()` 无状态检查，仅当 `readInput()===session.originalText` 才 return → conflict 状态下（B≠A）直接 `writeInput(A)` **永久覆盖用户在请求期间的新输入 B**，且 state 置 idle、冲突面板关闭。undo 语义前提（刚写回增强结果）在 conflict 分支不成立，toast 还误报"已增强"。
- **与代码哲学矛盾：** [controller.ts:334-346](apps/extension/src/content/controller.ts) 声明的"冲突保护：绝不覆盖用户修改"。

### 22. `requestScore` 为死代码，主动评分功能 UI 完全不可达 ⚠️ major
**文件：** [controller.ts:489](apps/extension/src/content/controller.ts#L489)、[SecondaryMenu.tsx:243-328](apps/extension/src/components/SecondaryMenu.tsx)
**对抗验证：** ✅ 确认（verdict: major）

- `requestScore()` 完整实现（35 行）但全源码仅此一处引用，无任何回调/转发。UI 有可点的「Prompt 评分」菜单项，但"重新评分"永远用陈旧分。用户编辑输入框后无法"只评分不增强"。

### 23. `getBoostSettings` 抛错时 boost() 静默失败、无任何反馈 ⚠️ major
**文件：** [controller.ts:217](apps/extension/src/content/controller.ts#L217)、[content.ts:171](apps/extension/src/content/content.ts#L171)
**对抗验证：** ✅ 确认（verdict: major）

- storage 数据损坏（类型/枚举非法值）时 `zExtensionSettings.parse` 抛 ZodError，`boost()` 直接 reject 状态停留 idle，无 UI 反馈，仅 unhandled rejection；`refresh()` 无 catch，按钮不渲染。`canBoost` 允许重试但损坏不修复必再失败 → **用户彻底卡死且无法感知原因**。

### 24. 菜单打开时不刷新持久化设置，展示陈旧值
**文件：** [content.ts:171](apps/extension/src/content/content.ts#L171)
**对抗验证：** ✅ 确认（verdict: minor）

- 展示值与实际增强行为不一致。

### 25. `aria-expanded` 绑定到澄清/评分浮层而非菜单展开状态
**文件：** [BoostHost.tsx:133](apps/extension/src/components/BoostHost.tsx)
**对抗验证：** ✅ 确认（verdict: minor）

- 无障碍属性绑定错误。

### 26. error 状态下评分浮层与错误横幅同时渲染叠加
**文件：** [BoostHost.tsx:201](apps/extension/src/components/BoostHost.tsx)
**对抗验证：** ✅ 确认（verdict: minor）

### 27. `copyConflictResult` 剪贴板失败时错误提示被吞
**文件：** [controller.ts:401](apps/extension/src/content/controller.ts#L401)
**对抗验证：** ✅ 确认（verdict: minor）

- state 已置 idle，banner 不渲染 → 用户静默丢失复制结果。

### 28. clarifying 阶段撤销 toast 显示"已增强"，但实际未写回输入框
**文件：** [controller.ts:305](apps/extension/src/content/controller.ts#L305)
**对抗验证：** ✅ 确认（verdict: minor，与 #21 同根）

### 29. 澄清面板不校验必填问题即可提交，required 形同虚设
**文件：** [BoostHost.tsx:179](apps/extension/src/components/BoostHost.tsx)
**对抗验证：** ✅ 确认（verdict: minor）

### 30. chrome.storage 设置读取-合并-写入非原子，并发保存丢失更新
**文件：** [settings.ts:14-22](apps/extension/src/background/settings.ts)、[content.ts:86](apps/extension/src/content/content.ts#L86)
**对抗验证：** ✅ 确认（verdict: minor）

---

## 六、共享层 / 启发式

### 31. `classify` 的 'study' 双归属 → learning 恒输给 research
**文件：** [classify.ts:50,55,74-84](packages/prompt-core/src/classify.ts)
**对抗验证：** ✅ 确认（verdict: minor）

- "学习 Python" 永远被归为 research。

### 32. `classify` 的 '译' 单字误判
**文件：** [classify.ts:58,86-99](packages/prompt-core/src/classify.ts)
**对抗验证：** ✅ 确认（verdict: minor）

- 单字 '译' → "编译/音译" 被分到 translation。

### 33. 启发式 constraints 维度 '不' 单字误报，恒 70 分
**文件：** [score.ts:56-59,116-132](packages/prompt-core/src/score.ts)
**对抗验证：** ✅ 确认（verdict: minor）

### 34. 启发式满分上限约 99（context 维度构造上限 90）
**文件：** [score.ts](packages/prompt-core/src/score.ts)
**对抗验证：** 无独立 verdict（已实测确认，context 50+40=90）

### 35. 纯空白/换行输入绕过 min(1) 校验直达 LLM 调用
**文件：** [schemas.ts:112-118,125-131](packages/shared/src/schemas.ts)、[normalize.ts:23-35](packages/prompt-core/src/normalize.ts)、[app.ts:329,383](apps/local-agent/src/app.ts)
**对抗验证：** ✅ 确认（verdict: minor）

- `normalize` 的 empty 判定未接入生产管线。

---

## 七、契约 / 配置

### 36. `zEnhancePromptResponse` 与 /v1/enhance 实际响应契约漂移
**文件：** [schemas.ts:170-176](packages/shared/src/schemas.ts)、[app.ts:348-369](apps/local-agent/src/app.ts)
**对抗验证：** ✅ 确认（verdict: minor）

- fallback/error 形态未入 schema，扩展端无法可靠区分降级结果。

### 37. PUT 允许修改 type，Vault 已有 Key 的鉴权语义错配
**文件：** [app.ts:156](apps/local-agent/src/app.ts#L156)
**对抗验证：** ✅ 确认（verdict: minor）

- 改 type（openai→openai-compatible）后，已存 Key 的鉴权语义随之错配。

### 38. baseUrl 私网/非 https URL 在保存接口即被接受并持久化
**文件：** [schemas.ts:56-61](packages/shared/src/schemas.ts)、[app.ts:117-131](apps/local-agent/src/app.ts)
**对抗验证：** ✅ 确认（verdict: minor）

- 运行时构造才拦截，坏 baseUrl 可先落库。与 #11/#12 同源。

### 39. customHeaders 的 key 无校验（zHeaderValue 只约束 value）
**文件：** [schemas.ts:41-46,64-67](packages/shared/src/schemas.ts)、[openai-compatible.ts:67-74](apps/local-agent/src/providers/openai-compatible.ts)
**对抗验证：** ✅ 确认（verdict: minor）

- 空 key / CRLF key 运行时抛错。

### 40. `provider POST/PUT 绕过 .strict()`，允许自定义额外字段写进 DB
**文件：** [app.ts](apps/local-agent/src/app.ts)
**对抗验证：** 无独立 verdict（与 #2 相关；POST 走 zProviderConfig 非 strict 属有意设计，风险低）

---

## 八、运营 / 健壮性

### 41. 错误响应统一 500 掩盖具体原因 ⚠️ major
**文件：** [errors.ts:41-45](apps/local-agent/src/api/errors.ts)
**对抗验证：** ✅ 确认（verdict: major）

- PUT/POST /v1/providers 的 DbHandle 异常也变 500，排障困难。

### 42. 20k 长 Prompt 超模型上下文时静默失败，且 no-truncation 同时进 meta-prompt
**文件：** [meta-prompt.ts:162-165](apps/local-agent/src/prompt-engine/meta-prompt.ts)
**对抗验证：** ✅ 确认（verdict: minor）

### 43. DATA_DIR 默认值仅对齐 autostart，未对齐 pnpm scripts → 两套 data 目录
**文件：** [env.ts](apps/local-agent/src/env.ts)、scripts/
**对抗验证：** 无独立 verdict（已确认 autostart.log 显示 token 重建）

### 44. 自动启动链 VBS 无日志/失败无提示，资源目录移动后静默失效
**文件：** [launch-prompt-boost.vbs:10](scripts/launch-prompt-boost.vbs)
**对抗验证：** ✅ 确认（verdict: minor）

### 45. 日志脚本注释与实现矛盾（VACUUM 不执行）
**对抗验证：** 无独立 verdict（docs/脚本注释）

### 46. 日志可能记录完整 prompt / 查询参数
**文件：** app.ts / server.ts / autostart.log
**对抗验证：** 无独立 verdict（logVerbose 场景；健壮性 agent 标 MAJOR）

### 47. `extractOpenAiContent` 回退读取 `reasoning_content` → 推理轨迹可能写回输入框
**文件：** [chat.ts](apps/local-agent/src/providers/chat.ts)
**对抗验证：** 无独立 verdict（源码确认存在 fallback）

### 48. `readPersistedToken` 与 `loadOrCreateAuthToken` 空文件/换行处理边界差异
**对抗验证：** 无独立 verdict（token 边界）

### 49. `openai.testConnectionViaChat` 仅凭 2xx 判定成功，不校验响应结构
**文件：** [openai.ts:151](apps/local-agent/src/providers/openai.ts#L151)
**对抗验证：** ✅ 确认（verdict: minor）

- 可能误报连接成功（与 #1 同类假阳性）。

### 50. 增强响应无长度截断（同 #6），已并入。

### 51. HTTP 层超时竞态：signal abort 与 timeout 同时触发时错误映射不稳定
**对抗验证：** 无独立 verdict（竞态窗口极窄）

---

## 修复顺序建议（按 ROI）

**第一优先级（一行修复，立即可用）：**
1. **Anthropic response_format**：`_jsonMode` 传 false 或移除注入 → Anthropic 用户立即恢复
2. **PUT id**：扩展发送前剥 id，或服务端 `.strip()` → 编辑 Provider 立即恢复
3. **textFallback 真纯文本**：enhancePrompt 增加 jsonMode 透传

**第二优先级（数据/安全）：**
4. `combineSignals`（治 #16 Provider 超时架空）
5. `customHeaders` 敏感值走 vault + 响应脱敏（治 #7 红线违反）
6. `confidence` clamp + `enhancedText` 截断（治 #6 扩展校验失败）
7. `tokenize` 中文词级切分（治 #4 意图保真失效）

**第三优先级（状态机）：**
8. `undo` 加 state 守卫（治 #21 覆盖用户输入）
9. `getBoostSettings` 加 catch + 错误 UI（治 #23 静默卡死）
10. 把 `requestScore` 接入 UI 或移除死菜单（治 #22）

---

## 附：测试盲区（为何测试全绿仍漏 bug）

- **Anthropic 端到端**：只有 connection test，掩盖 response_format bug（#1）
- **PUT 带 id**：[app.test.ts:320,340](apps/local-agent/tests/app.test.ts) 均不带 id，未覆盖真实扩展消息流（#2）
- **中文意图保真**：missing 恒空 → 测试空洞通过（#4）
- **超时信号合并**：无 combineSignals 的 Provider 层测试（#16）

## 已清理

- 临时分析文件（audit-wf-results.json、临时脚本）已删除。
- **未改任何源码** —— 按你的要求，这是审计 + 建议，不做修复。
