# Clarification Fix Report（Smart 追问修复验收报告）

日期：2026-08-07
范围：Prompt Boost Smart Clarification 生产链路修复
状态：✅ 已修复并全链路验证通过

---

## 1. 根因（Root Cause）

**Meta-prompt 过度鼓励"自行假设" + 程序侧无强制追问 Gate。**

全链路逐层审计（设置 → BoostController → background → HTTP → Zod → prompt-engine → Provider → 响应 → controller → UI）确认：`clarificationMode` 在每一层都完整透传，字段没有任何丢失。真正的缺陷有两处：

- **模型侧**：旧 meta-prompt 的【场景补强原则】写的是"缺什么补什么"，assumptions 字段说明没有限制，导致模型对含糊 Prompt（如"帮我做个推广方案"）几乎总是自行假设（假设成新产品/默认市场/默认预算），返回 `clarificationRequired: false`，从不触发追问。
- **程序侧**：没有任何 Gate。控制器旧判定是 `clarificationRequired && questions.length>0 && mode!==off`，而 `clarificationRequired` 完全信任模型自评的布尔值——模型填 `false` 就永不追问。

## 2. 故障层

- **主因层**：`apps/local-agent/src/prompt-engine/meta-prompt.ts`（提示词策略）。
- **次因层**：`pipeline.ts` 与 `controller.ts`（缺程序侧 Gate，把追问决策完全交给模型自评布尔）。

## 3. 修复设计：Clarification Gate（程序把关，模型只做语义）

新增 `criticalMissingInformation: string[]`（会显著改变最终 Prompt 目标/对象/策略/约束/输出的关键缺失信息）。**模型负责语义**（列出哪些关键信息缺失），**程序负责 Gate**：

```ts
// smart 语义判定：clarificationRequired 由程序从 criticalMissingInformation 派生，
// 不信任模型自评布尔值。
clarificationRequired = criticalMissingInformation.length > 0;

// 控制器 Gate：
function shouldShowClarification(mode, enhanceLevel, analysis) {
  if (mode === "off")    return false;                                  // off → 永不追问
  if (enhanceLevel === "quick") return false;                           // quick → 快速档不打断
  if (mode === "always") return analysis.clarificationQuestions.length > 0; // always → 有问题即追问
  if (mode === "smart")  return analysis.clarificationRequired === true
    && analysis.clarificationQuestions.length > 0;                      // smart → 双重条件
  return false;
}
```

## 4. 修改文件

| 文件 | 改动 |
|---|---|
| `packages/shared/src/types.ts` | `PromptAnalysis` 新增 `criticalMissingInformation: string[]` |
| `packages/shared/src/schemas.ts` | `zPromptAnalysis` 新增 `criticalMissingInformation` |
| `apps/local-agent/src/providers/types.ts` | `EnhanceJsonOutput` / `parseEnhanceJsonOutput` / `ProviderAnalyzeResult` / `parseProviderAnalyzeResult` 全部透传 |
| `apps/local-agent/src/prompt-engine/meta-prompt.ts` | 【追问】改为"关键缺失必须追问，不是自行假设"；JSON 契约+字段说明+`clarificationModeDirective`+【场景补强原则】同步收紧 |
| `apps/local-agent/src/prompt-engine/pipeline.ts` | `toAnalysis()` 增加参数；`runEnhance` 由 `criticalMissingInformation.length>0` 派生 `clarificationRequired`；降级路径补空数组 |
| `apps/extension/src/content/controller.ts` | 接入 `shouldShowClarification`（含 quick 抑制）；追问期间不写回输入框；`PROMPT_BOOST_DEBUG=true` 诊断日志（仅非敏感元数据）；`upstreamCallCount` 统计 |

## 5. 诊断日志（PROMPT_BOOST_DEBUG=true）

`console.debug("[prompt-boost][debug]", ...)` 输出**仅非敏感元数据**：
`requestId / enhanceLevel / clarificationMode / clarificationRequired / questionCount / criticalCount / showClarification / hasAnswers / controllerState / upstreamCallCount / taskType / detectedTaskType / errorCode`。

**绝不输出**：API Key、Authorization、完整 prompt、完整模型响应、用户回答内容。启用方式：扩展 content script 环境 `process.env.PROMPT_BOOST_DEBUG === "true"` 时打开。

## 6. 新增/更新测试

- **7 个生产链路集成测试**（`apps/extension/src/content/controller-clarification-integration.test.ts`）：
  - Test1 含糊 Prompt+问题 → `clarifying` + writeInput=0
  - Test2 smart+信息充分 → writeInput=1（不追问直接写回）
  - Test3 off → 无追问 UI，直接写回
  - Test4 使用默认假设 → 仅 1 次上游调用
  - Test5 回答并增强 → 累计 2 次调用，第二次带 answers
  - Test6 取消（dismiss）→ 0 额外调用、0 写回、保留原文
  - Test7 竞态隔离 → 新会话发起后，旧会话晚到响应被丢弃
- **Gate 单测 4 个**（off/quick/always/smart 各分支）。
- **设置持久化透传 3 个**（smart/off/always 各自透传到请求体；refresh 不触发增强请求）。
- **prompt-engine 单测更新**（`tests/prompt-engine.test.ts`）：`okEnhance()` 补字段；新增"模型漏设布尔但列出关键缺失 → 程序仍置 true"与"off 模式问题过滤为空但语义标记保留"用例。
- **schemas / controller-stage6 / controller-stage7 测试**：fixture 补 `criticalMissingInformation` 字段。

## 7. Smart 模式实测（含糊 Prompt）

输入："帮我做个推广方案"

- **修复前**：模型自行假设 → `clarificationRequired:false` → 直接写回，无追问 UI。
- **修复后（关键缺失时）**：`criticalMissingInformation.length>0` → 程序派生 `clarificationRequired=true` → Gate 通过 → 进入 `clarifying`，渲染 1–3 个追问问题，输入框保留原文，不写回。

## 8. 各模式真实结果

| 模式 | 表现 |
|---|---|
| smart + 关键缺失 | ✅ 追问（clarificationRequired=true + 问题 ≤3 → clarifying UI） |
| smart + 信息充分 | ✅ 不追问，1 次调用直接写回 |
| off | ✅ 永不追问，直接写回（问题过滤为空） |
| always | ✅ 有问题即追问 |
| quick（任意模式） | ✅ Gate 抑制追问，不打断快速增强 |

## 9. 调用次数（任务卡要求）

| 动作 | 上游调用次数 |
|---|---|
| Use Defaults（使用默认假设） | **1** 次（直接用首轮结果，不再问模型） |
| Answer（回答并增强） | **2** 次（首轮 + 带 answers 二轮） |
| Cancel（取消/关闭） | **0** 额外调用，0 写回，输入框保留原文 |

## 10. 状态机

`idle → reading → analyzing → clarifying` 在 clarifying 停住，**controller 不在 clarifying 期间调用 writeInput**；只有 使用默认假设 / 回答并增强 / 取消 三种出口离开 clarifying。

## 11. 测试统计

| 包 | 测试文件 | 用例数 |
|---|---|---|
| shared | schemas.test | 10 |
| prompt-core | — | 21 |
| local-agent | 9 文件（含 prompt-engine 20） | 119 |
| extension | 10 文件（含澄清链路集成 14） | **109** |
| **合计** | | **259** |

`pnpm check` = lint ✅ + typecheck ✅ + test ✅ + build ✅，全部通过。

## 12. 最终 Smoke Test（smoke-test-final.mjs）

全部通过（55 项断言），含新增 Clarification 用例：
- 6b 首轮 `clarificationRequired=true` + `criticalMissingInformation` 2 项 + **3 个问题**（≤3）→ 带 answers 二轮拿到最终结果，累计 2 次上游调用；
- 6c off 模式问题过滤为空、1 次调用；
- 真实 `data/` hash+mtime 前后一致，全程零修改。

---

**结论**：Smart Clarification 追问失效已修复，根因（meta-prompt 过度假设 + 无程序侧 Gate）已在模型语义层与程序 Gate 层双重解决，全链路（Controller→background→HTTP→Zod→Pipeline→Provider→UI）验证通过。
