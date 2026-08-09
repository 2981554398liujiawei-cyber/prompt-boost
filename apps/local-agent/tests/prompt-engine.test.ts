/**
 * Prompt Engine 管线测试（阶段 5）。
 *
 * 用「可编程 Mock Provider」直接驱动 runEnhance，逐次返回预设结果，
 * 验证六项产品要求：
 *   1. 输出必须是「增强后的 Prompt」，不是直接回答用户任务。
 *   2. quick / deep / expert 三档有可感知差异（指令强度/动作数量/长度）。
 *   3. 分类、评分、追问与增强合并在一次 LLM 调用完成（mock 调用计数 = 1）。
 *   4. 结构化返回失败可修复或安全降级（RESPONSE_INVALID → 纯文本 → 原样返回）。
 *   5. 增强结果保留用户核心意图（不丢核心词）。
 *   6. scoreDimensions 来自 LLM，程序算 totalScore；降级时 heuristic_fallback。
 */
// 路径隔离副作用必须先于任何 src 模块的静态导入执行（ESM 提升）。
import "./paths-env.js";
import { describe, expect, it } from "vitest";
import type { EnhancePromptRequest } from "@prompt-boost/shared";
import type { ProviderEnhanceResult, AnalyzePromptRequest, ModelProvider } from "../src/providers/types.js";
import { ProviderError } from "../src/providers/types.js";
import { runEnhance, missingCoreTokens } from "../src/prompt-engine/pipeline.js";
import { buildSystemPrompt, buildUserPrompt } from "../src/prompt-engine/meta-prompt.js";

/** 可编程 Mock Provider：按剧本依次返回 / 抛出。 */
function mockProvider(script: Array<ProviderEnhanceResult | Error>): ModelProvider & {
  calls: AnalyzePromptRequest[];
  options: Array<Record<string, unknown> | undefined>;
} {
  const calls: AnalyzePromptRequest[] = [];
  const options: Array<Record<string, unknown> | undefined> = [];
  let idx = 0;
  const provider = {
    type: "openai",
    config: {
      id: "mock",
      name: "Mock",
      type: "openai" as const,
      baseUrl: "https://mock.local/v1",
      model: "gpt-4o-mini",
      timeoutSeconds: 30,
      enabled: true,
    },
    calls,
    options,
    async testConnection(): Promise<never> {
      throw new Error("not used");
    },
    async analyzePrompt(): Promise<never> {
      throw new Error("not used");
    },
    async enhancePrompt(
      request: AnalyzePromptRequest,
      opts?: Record<string, unknown>,
    ): Promise<ProviderEnhanceResult> {
      calls.push(request);
      options.push(opts);
      const step = script[idx];
      if (idx < script.length - 1) idx += 1;
      if (step instanceof Error) throw step;
      return step;
    },
  };
  return provider as unknown as ModelProvider & {
    calls: AnalyzePromptRequest[];
    options: Array<Record<string, unknown> | undefined>;
  };
}

function okEnhance(overrides?: Partial<ProviderEnhanceResult>): ProviderEnhanceResult {
  return {
    enhancedText:
      "请以资深产品经理的视角，为公司的新产品撰写一份完整的推广方案。请包括：背景分析、目标受众、渠道策略、时间计划与预算分配。输出为带小标题的 Markdown。",
    analysis: {
      detectedTaskType: "business",
      confidence: 0.9,
      scoreDimensions: {
        objective: 80,
        context: 70,
        audience: 60,
        outputFormat: 85,
        constraints: 50,
        role: 75,
        materials: 40,
        actionability: 70,
      },
      totalScore: 0,
      scoreSource: "llm",
      missingInformation: ["预算", "渠道"],
      criticalMissingInformation: [],
      suggestions: ["补充预算范围"],
      clarificationRequired: false,
      clarificationQuestions: [],
    },
    assumptions: ["假设为新产品发布"],
    ...overrides,
  };
}

const REQUEST: EnhancePromptRequest = {
  originalText: "帮我写一个产品推广方案",
  taskType: "auto",
  enhanceLevel: "deep",
  clarificationMode: "smart",
  outputLanguage: "auto",
};

describe("输出必须是增强后的 Prompt（不是直接回答）", () => {
  it("把原始 Prompt 改写为更完整的指令，而非生成方案正文", async () => {
    const p = mockProvider([okEnhance()]);
    const out = await runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" });
    // enhancedText 仍是「撰写方案」类指令（含 请/撰写/包括…），不是方案正文。
    expect(out.enhancedText).toContain("请");
    expect(out.enhancedText).not.toBe("帮我写一个产品推广方案");
    // 不输出用户任务的具体内容（不包含「正文式」答案特征）。
    expect(out.enhancedText.length).toBeGreaterThan(REQUEST.originalText.length);
  });
});

describe("quick / deep / expert 三档差异", () => {
  // 三档 prompt 指令定义必须不同，且 quick 最轻、expert 最重。
  it("user prompt 对三档生成不同强度指令", () => {
    const q = buildUserPrompt({ ...REQUEST, enhanceLevel: "quick" });
    const d = buildUserPrompt({ ...REQUEST, enhanceLevel: "deep" });
    const e = buildUserPrompt({ ...REQUEST, enhanceLevel: "expert" });
    expect(q).not.toBe(d);
    expect(d).not.toBe(e);
    expect(e).toContain("全面结构化");
    expect(e).toContain("资深模型");
    expect(q).toContain("只做必要的最小改动");
    expect(d).toContain("中等重写");
  });

  it("mock 返回随增强等级变化（expert 输出更长、动作更多）", async () => {
    const makeText = (level: string): ProviderEnhanceResult =>
      okEnhance({
        enhancedText:
          level === "expert"
            ? "请以资深产品经理的视角…包含背景分析、目标受众、渠道策略、时间计划、预算分配、里程碑、风险预案。输出 Markdown 大纲。"
            : "请为公司新产品写一份推广方案，包含目标受众与渠道。",
      });
    const p = mockProvider([makeText("expert")]);
    const outExpert = await runEnhance({ ...REQUEST, enhanceLevel: "expert" }, { provider: p, providerLabel: "openai/mock" });
    const p2 = mockProvider([makeText("quick")]);
    const outQuick = await runEnhance({ ...REQUEST, enhanceLevel: "quick" }, { provider: p2, providerLabel: "openai/mock" });
    // expert 明显更长、动作（动作词数量）更多。
    expect(outExpert.enhancedText.length).toBeGreaterThan(outQuick.enhancedText.length);
    expect(p.calls).toHaveLength(1);
    expect(p2.calls).toHaveLength(1);
  });
});

describe("单次 LLM 调用完成分类+评分+追问+增强", () => {
  it("一次 enhance 只触发一次 provider.enhancePrompt（mock 计数 = 1）", async () => {
    const p = mockProvider([okEnhance()]);
    const out = await runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" });
    expect(p.calls).toHaveLength(1);
    // 同一调用既给出增强文本又给出评分维度与任务类型。
    expect(out.analysis?.scoreDimensions.objective).toBe(80);
    expect(out.analysis?.detectedTaskType).toBe("business");
    expect(out.analysis?.scoreSource).toBe("llm");
  });

  it("追问答案并入 user prompt（一次调用）", async () => {
    const p = mockProvider([okEnhance()]);
    await runEnhance(
      { ...REQUEST, clarificationAnswers: { q1: "预算 10 万，面向中小企业" } },
      { provider: p, providerLabel: "openai/mock" },
    );
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].userPrompt).toContain("预算 10 万");
  });
});

describe("结构化失败可修复或安全降级", () => {
  const respInvalid = new ProviderError({
    code: "RESPONSE_INVALID",
    providerType: "openai",
    retryable: false,
    safeMessage: "无法解析 JSON",
  });

  it("RESPONSE_INVALID → 纯文本降级成功", async () => {
    const p = mockProvider([respInvalid, okEnhance()]);
    const out = await runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" });
    expect(p.calls).toHaveLength(2); // 第一次失败 + 纯文本重试。
    expect(out.enhancedText.length).toBeGreaterThan(0);
    expect(out.fallback).not.toBe("passthrough"); // 纯文本成功，未原样返回。
  });

  it("结构化解析失败且纯文本也失败 → 原样返回（不丢用户输入）", async () => {
    const p = mockProvider([respInvalid, respInvalid]);
    const out = await runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" });
    expect(out.enhancedText).toBe(REQUEST.originalText);
    expect(out.fallback).toBe("passthrough");
    // 原样返回时也带 heuristic 分析（scoreSource: heuristic_fallback）。
    expect(out.analysis?.scoreSource).toBe("heuristic_fallback");
    expect(out.analysis?.totalScore).toBeGreaterThan(0);
  });

  it("Provider 层错误（非 RESPONSE_INVALID）不降级，直接上抛", async () => {
    const timeoutErr = new ProviderError({
      code: "TIMEOUT",
      providerType: "openai",
      retryable: true,
      safeMessage: "请求超时",
    });
    const p = mockProvider([timeoutErr]);
    await expect(runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" })).rejects.toThrow();
    expect(p.calls).toHaveLength(1);
  });

  it("首次调用默认 jsonMode=true（结构化）；纯文本降级请求带 jsonMode=false", async () => {
    const p = mockProvider([respInvalid, okEnhance()]);
    const out = await runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" });
    expect(p.calls).toHaveLength(2);
    // 第一次结构化：未显式传 jsonMode（缺省 true，pipeline 只传 signal）。
    expect(p.options[0]?.jsonMode).toBeUndefined();
    // 纯文本降级：必须显式 jsonMode=false，否则 response_format 仍被注入（非真纯文本）。
    expect(p.options[1]).toMatchObject({ jsonMode: false });
    expect(out.fallback).not.toBe("passthrough");
  });

  it("结构化与纯文本结果都丢失核心意图 → 安全回退原文", async () => {
    // 修复 D 回归守卫：英文核心词（python/excel）被改写成 javascript/pdf 时
    // 会产生 2 个独立缺失 → gate 拦截 → 转纯文本重试（jsonMode=false）。
    const intentLost = okEnhance({
      enhancedText: "请写一个 javascript 脚本来解析 pdf 文件，输出结构化数据。",
    });
    const p = mockProvider([intentLost, okEnhance()]);
    const out = await runEnhance(
      { ...REQUEST, originalText: "我要一个 python 脚本解析 excel 文件" },
      { provider: p, providerLabel: "openai/mock" },
    );
    expect(p.calls).toHaveLength(2);
    expect(p.options[1]).toMatchObject({ jsonMode: false });
    // 第二次 mock 结果同样不含 python/excel；纯文本降级也必须经过意图 gate，
    // 不能把另一段看似合理但无关的 Prompt 写回输入框。
    expect(out.fallback).toBe("passthrough");
    expect(out.enhancedText).toBe("我要一个 python 脚本解析 excel 文件");
  });
});

describe("核心意图保真", () => {
  it("增强文本不丢失原始 Prompt 的核心词", () => {
    const original = "帮我写一个产品推广方案";
    const enhanced = "请撰写一份产品推广方案，包括目标受众与渠道策略";
    const missing = missingCoreTokens(original, enhanced);
    expect(missing).not.toContain("产品");
    expect(missing).not.toContain("推广");
    expect(missing).not.toContain("方案");
  });

  it("模型改写了核心词（近义词）也视为可接受", () => {
    const original = "帮我写一个产品推广方案";
    const enhanced = "请为公司新产品撰写市场宣传计划";
    // 允许丢失 ≤1 个核心词（模型改写近义词），但绝不丢失 ≥2。
    const missing = missingCoreTokens(original, enhanced);
    expect(missing.length).toBeLessThanOrEqual(1);
  });

  it("纯中文输入意图保真生效：核心词改写（狗→猫）被拦截", () => {
    // 修复 D：tokenize 中文不再按字级丢弃。模型把「狗」幻觉成「猫」，应判定意图丢失。
    const original = "写一首关于狗的诗";
    const enhanced = "写一首关于猫的诗";
    const missing = missingCoreTokens(original, enhanced);
    expect(missing.join("")).toContain("狗");
    expect(missing.join("")).not.toContain("猫"); // 缺失是原词的狗，不是增强里的猫。
  });

  it("单字实义概念缺失被拦截（非停用词单字参与校验）", () => {
    // 修复 D 的回归守卫：单字实词（非停用词）缺失必须进入缺失列表。
    const missing = missingCoreTokens("帮我写一首诗", "帮我写一首词");
    expect(missing.join("")).toContain("诗");
  });

  it("英文核心词（Python）改写缺失被拦截", () => {
    const missing = missingCoreTokens("帮我写一个 python 脚本", "帮我写一个 javascript 脚本");
    expect(missing.join("")).toContain("python");
  });
});

describe("评分来源", () => {
  it("正常路径 scoreSource = llm，totalScore 由程序计算", async () => {
    const p = mockProvider([okEnhance()]);
    const out = await runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" });
    expect(out.analysis?.scoreSource).toBe("llm");
    // totalScore = 加权总分（模型给维度分，程序算总分）。
    expect(out.analysis?.totalScore).toBeGreaterThan(0);
    expect(out.analysis?.totalScore).toBeLessThanOrEqual(100);
  });

  it("confidence 越界（1.5）被 clamp 到 [0,1]", async () => {
    const p = mockProvider([
      okEnhance({
        analysis: { ...okEnhance().analysis, confidence: 1.5 },
      }),
    ]);
    const out = await runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" });
    // 修复 E：越界 confidence 不得导致扩展端 zod 校验失败丢单。
    expect(out.analysis?.confidence).toBe(1);
  });

  it("confidence 为负值被 clamp 到 0", async () => {
    const p = mockProvider([
      okEnhance({
        analysis: { ...okEnhance().analysis, confidence: -0.5 },
      }),
    ]);
    const out = await runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" });
    expect(out.analysis?.confidence).toBe(0);
  });

  it("enhancedText 超过 MAX_INPUT_LENGTH 被截断（扩展端 zod 不再拒绝）", async () => {
    const p = mockProvider([
      okEnhance({
        enhancedText: `请撰写方案。${"内容".repeat(30_000)}`,
      }),
    ]);
    const out = await runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" });
    // 修复 E：截断到 20000，且仍通过意图保真（前段含核心词）。
    expect(out.enhancedText.length).toBeLessThanOrEqual(20_000);
    expect(out.enhancedText).toContain("撰写");
  });

  it("模型输出非法维度值时，程序 sanitize 后仍返回合法结果", async () => {
    const p = mockProvider([
      okEnhance({
        analysis: {
          ...okEnhance().analysis,
          scoreDimensions: { objective: 120, context: -5 } as never,
        },
      }),
    ]);
    const out = await runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" });
    expect(out.analysis?.scoreSource).toBe("llm");
    // sanitizeDimensions 把 120 钳到 100、-5 钳到 0，其余补 0。
    expect(out.analysis?.scoreDimensions.objective).toBe(100);
    expect(out.analysis?.scoreDimensions.context).toBe(0);
    expect(out.analysis?.scoreDimensions.outputFormat).toBe(0);
  });
});

describe("meta-prompt 关键约束", () => {
  it("system prompt 强调输出增强后的 Prompt 而非直接回答", () => {
    const sys = buildSystemPrompt();
    expect(sys).toContain("增强后的 Prompt");
    expect(sys).toContain("绝对不要替用户执行");
    expect(sys).toContain("原始意图");
  });

  it("user prompt 包含任务类型定义与输出语言规则", () => {
    const user = buildUserPrompt({ ...REQUEST, outputLanguage: "english" });
    expect(user).toContain("business");
    expect(user).toContain("english");
  });
});

describe("Stage 7：追问闭环（LLM 产出问题）", () => {
  /** 模型判断关键信息缺失：同时产出 criticalMissingInformation 与追问问题。 */
  function withCriticalInfo(
    critical: string[],
    questions: NonNullable<NonNullable<ProviderEnhanceResult["analysis"]>["clarificationQuestions"]>,
  ): ProviderEnhanceResult {
    return okEnhance({
      analysis: {
        ...okEnhance().analysis,
        criticalMissingInformation: critical,
        clarificationQuestions: questions,
      },
    });
  }

  it("smart 模式：LLM 标记关键信息缺失 → 程序派生 clarificationRequired=true + 透传 questions", async () => {
    const p = mockProvider([
      withCriticalInfo(
        ["目标市场", "预算"],
        [
          { id: "q1", question: "推广的目标市场是？", reason: "影响策略选择", required: true },
          { id: "q2", question: "预算范围？", reason: "影响方案深度", required: false },
        ],
      ),
    ]);
    const out = await runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" });
    expect(out.analysis?.clarificationRequired).toBe(true); // 程序由 criticalMissingInformation 派生。
    expect(out.analysis?.criticalMissingInformation).toEqual(["目标市场", "预算"]);
    expect(out.analysis?.clarificationQuestions).toHaveLength(2);
    expect(out.analysis?.clarificationQuestions[0].question).toContain("目标市场");
  });

  it("程序侧派生：模型漏设布尔值但列出关键缺失信息 → 程序仍置为 true（不信任自评）", async () => {
    const p = mockProvider([
      okEnhance({
        analysis: {
          ...okEnhance().analysis,
          criticalMissingInformation: ["目标用户"],
          clarificationRequired: false, // 模型自评漏设（旧行为）。
          clarificationQuestions: [{ id: "q1", question: "目标用户是谁？", reason: "影响对象", required: true }],
        },
      }),
    ]);
    const out = await runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" });
    expect(out.analysis?.clarificationRequired).toBe(true);
  });

  it("off 模式：问题被过滤为空；clarificationRequired 仍按程序语义派生（由 Gate 决定是否展示）", async () => {
    const p = mockProvider([
      withCriticalInfo(
        ["目标市场"],
        [{ id: "q1", question: "目标市场？", reason: "影响策略", required: true }],
      ),
    ]);
    const out = await runEnhance(
      { ...REQUEST, clarificationMode: "off" },
      { provider: p, providerLabel: "openai/mock" },
    );
    expect(out.analysis?.clarificationQuestions).toHaveLength(0);
    // 语义层仍标记（供 Gate 使用）；off 是否展示由控制器 Gate 决定。
    expect(out.analysis?.clarificationRequired).toBe(true);
  });

  it("已提供追问答案（第二次增强）不再追问", async () => {
    const p = mockProvider([
      withCriticalInfo(
        ["目标市场"],
        [{ id: "q1", question: "目标市场？", reason: "影响策略", required: true }],
      ),
    ]);
    const out = await runEnhance(
      { ...REQUEST, clarificationAnswers: { q1: "面向中小企业" } },
      { provider: p, providerLabel: "openai/mock" },
    );
    expect(out.analysis?.clarificationQuestions).toHaveLength(0);
  });

  it("问题最多 3 个（超出截断）", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `q${i + 1}`,
      question: `问题 ${i + 1}？`,
      reason: "理由",
      required: false,
    }));
    const p = mockProvider([withCriticalInfo(["信息"], many)]);
    const out = await runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" });
    expect(out.analysis?.clarificationQuestions.length).toBeLessThanOrEqual(3);
  });

  it("信息充分：criticalMissingInformation 为空 → clarificationRequired=false 且无问题", async () => {
    const p = mockProvider([okEnhance()]);
    const out = await runEnhance(REQUEST, { provider: p, providerLabel: "openai/mock" });
    expect(out.analysis?.clarificationRequired).toBe(false);
    expect(out.analysis?.clarificationQuestions).toHaveLength(0);
  });
});
