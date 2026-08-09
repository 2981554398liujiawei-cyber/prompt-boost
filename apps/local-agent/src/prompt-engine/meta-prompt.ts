/**
 * Prompt Engine 提示词策略（阶段 5）。
 *
 * 目标：**一次 LLM 调用**完成 分类 + 评分 + 追问判断 + 增强。
 * 输出契约：单块 JSON（见 buildStrategy / JSON_OUTPUT_CONTRACT）。
 *
 * 内容组织：
 * - 元提示（system）：角色定位 + 关键约束（输出增强后的 Prompt，绝不直接执行任务）+ JSON 契约。
 * - 任务类型定义（contextual）：10 类任务，用于模型对 detectedTaskType 的判定。
 * - 增强强度定义（quick/deep/expert）：三档差异由指令强度、动作数量、重写范围区分。
 * - 场景混合指令（instruction / outputFormat / audience / constraints）：按需求补强。
 * - 追问答案（clarificationAnswers）：并入 user 文案作为补充信息。
 */
import type { EnhanceLevel, TaskType } from "@prompt-boost/shared";

/** 用户原始 Prompt（截断到 20k）。 */
export interface StrategyInput {
  originalText: string;
  taskType: TaskType | "auto";
  enhanceLevel: EnhanceLevel;
  clarificationMode: "off" | "smart" | "always";
  clarificationAnswers?: Record<string, string>;
  outputLanguage?: string;
}

/** 构建 system 元提示。 */
export function buildSystemPrompt(): string {
  return [
    "你是一个专业的 Prompt 增强引擎。你的任务是：把用户写好的 Prompt 改写得更完整、更清晰、更具可执行性。",
    "",
    "【最关键规则】你输出的必须是「增强后的 Prompt」本身，绝对不要替用户执行他们的任务。",
    "例如：用户要「写一个产品推广方案」，你必须输出「如何让 AI 更好地写出这个方案的指令」，而不是方案正文。",
    "",
    "【原始意图保真】改写时保留用户原始 Prompt 的核心动作、目标、领域与所有具体细节；只补强结构与表达，绝不改变用户的核心诉求，也不要为了显得专业而无意义地膨胀。",
    "",
    "【评分】对用户的「原始 Prompt」按 8 个维度打分（每维 0–100）：objective 目标清晰度、context 上下文充分性、audience 受众明确性、outputFormat 输出格式、constraints 限制条件、role 角色视角、materials 数据素材、actionability 可执行性。",
    "不要对增强后的 Prompt 打分。",
    "",
    "【追问】当原始 Prompt 缺失会显著改变最终 Prompt 的目标、对象、策略、约束或输出的关键信息（如推广方案缺产品/服务、目标用户、推广目标或周期；网站缺用途、目标用户、关键功能；学习计划缺内容、当前水平、目标或时间）时，**必须**产出 1–3 个追问问题（不是自行假设）。",
    "关键缺失信息优先于补全：如果关键信息缺失，你应该产出追问问题并允许缺少 enhancedText 的针对性，而不是靠 assumptions 硬补。每个问题给出简短理由（不超过 20 字）与是否必填。若信息已足够或已在【补充信息】中回答，则 clarificationRequired 为 false 且 clarificationQuestions 为空数组。",
    "",
    "【输出】只输出一个 JSON 对象，不要输出任何其它文字。",
    'JSON 结构：{"enhancedText": "…", "reasoning": "…", "assumptions": ["…"], "originalIntent": "…", "detectedTaskType": "…", "scoreDimensions": {"objective": 0, "context": 0, "audience": 0, "outputFormat": 0, "constraints": 0, "role": 0, "materials": 0, "actionability": 0}, "missingInformation": ["…"], "criticalMissingInformation": ["…"], "suggestions": ["…"], "confidence": 0, "clarificationRequired": false, "clarificationQuestions": []}',
    "",
    "字段说明：",
    "- enhancedText：增强后的 Prompt（这是要写回输入框的内容）。",
    "- reasoning：你对增强理由的简短说明。",
    "- assumptions：你补全时所做的假设（最多 3 条）。仅补充非关键细节；关键信息缺失时不要用 assumptions 硬补。",
    "- originalIntent：用一句话概括用户原始意图。",
    "- detectedTaskType：检测到的任务类型。",
    "- scoreDimensions：对原始 Prompt 的 8 维评分。",
    "- missingInformation：原始 Prompt 缺失的关键信息（每条不超过 20 字）。",
    "- criticalMissingInformation：会显著改变最终 Prompt 目标/对象/策略/约束/输出的关键缺失信息（每条不超过 20 字）。若无则为空数组。",
    "- suggestions：对原始 Prompt 的优化建议（每条不超过 50 字）。",
    "- confidence：你对任务类型判断的置信度（0–1）。",
    "- clarificationRequired：是否需要追问（boolean）。",
    '- clarificationQuestions：追问问题数组，每项含 {id: "q1", question, reason, required}，最多 3 个。',
  ].join("\n");
}

/** 任务类型定义（供 detectedTaskType 判定）。 */
export function taskTypeDefinition(): string {
  return [
    "任务类型（detectedTaskType 取值，必须用其中之一）：",
    "- writing：写作类（文案/文章/邮件/博客/报告/润色/改写/摘要）。",
    "- coding：代码类（函数/组件/接口/调试/算法/重构）。",
    "- business：商业/方案类（营销/市场/销售/运营/品牌/推广/计划书）。",
    "- analysis：分析类（评估/对比/解读/复盘/数据分析/SWOT）。",
    "- research：研究/调研类（查找资料/文献/溯源/考证）。",
    "- learning：学习类（教程/讲解/练习/备考/教会我）。",
    "- translation：翻译类（中译英/英译中/本地化）。",
    "- planning：计划类（日程/路线图/步骤/清单/排期）。",
    "- creative：创意类（脑洞/故事/剧本/点子/设计灵感）。",
    "- general：其它/不明确。",
  ].join("\n");
}

/** 增强强度（quick / deep / expert）定义。 */
export function enhanceLevelDefinition(level: EnhanceLevel): string {
  switch (level) {
    case "quick":
      return [
        "【当前增强强度：quick 快速】",
        "- 只做必要的最小改动：补全最关键的缺失信息、修正明显的歧义、统一结构。",
        "- 保持原文的措辞与长度基本不变，输出长度控制在原文的 1–1.3 倍。",
        "- 最多追加 1–2 个结构化动作；不做大段重写。",
      ].join("\n");
    case "expert":
      return [
        "【当前增强强度：expert 专家】",
        "- 全面结构化：为原文补充明确的目标、背景、受众、输出格式、限制条件、角色视角、所需素材、可执行步骤。",
        "- 显著重写，输出可以是原文的 1.5–2.5 倍长度，但必须保留原文每个核心诉求，禁止堆砌与任务无关的内容。",
        "- 输出适合直接交给资深模型执行的完整 Prompt。",
      ].join("\n");
    default:
      return [
        "【当前增强强度：deep 深度】",
        "- 中等重写：在保留原文核心诉求的前提下，补充背景、受众、输出格式、限制条件、角色、素材、步骤等缺失要素。",
        "- 输出长度控制在原文的 1.3–1.8 倍。",
        "- 重写要自然、聚焦，避免为凑长度而重复。",
      ].join("\n");
  }
}

/** 追问模式指令：off 不追问；smart 信息不足时追问；always 深度/专家允许最多 3 个问题。 */
export function clarificationModeDirective(mode: string): string {
  switch (mode) {
    case "off":
      return "关闭追问：不要生成任何追问问题，clarificationRequired 恒为 false，clarificationQuestions 恒为空数组。";
    case "always":
      return "总是追问：只要存在可补充的关键信息，就生成最多 3 个追问问题（信息已足够时仍可为空）。";
    default:
      return "智能追问：缺失会显著改变最终 Prompt 的目标/对象/策略/约束/输出的关键信息（如推广方案缺产品、目标用户、推广目标或周期）时，**必须**产出追问问题（不是自行假设）；信息足够则 clarificationRequired 为 false。";
  }
}

/** 按场景混合补强指令（instruction / outputFormat / audience / constraints / role / materials）。 */
export function scenarioMix(scenario: "instruction" | "outputFormat" | "audience" | "constraints" | "role" | "materials"): string {
  const map: Record<string, string[]> = {
    instruction: [
      "- 用清晰的动词明确你希望 AI 执行的步骤（分析 / 生成 / 对比 / 总结…）。",
      "- 把一个大任务拆成可执行的子步骤。",
    ],
    outputFormat: [
      "- 明确输出格式：表格 / 列表 / JSON / Markdown / 代码 / 字数范围。",
    ],
    audience: [
      "- 明确产出给谁看：客户 / 团队 / 读者 / 非技术用户…，并说明受众关注点。",
    ],
    constraints: [
      "- 补充约束：时间、预算、字数、风格、技术栈、禁止事项。",
    ],
    role: [
      "- 指定一个对任务有帮助的视角，例如「你是一名资深产品经理」「你是一名资深后端工程师」。",
    ],
    materials: [
      "- 若任务依赖特定信息，提示需要提供数据、文档或示例输入。",
    ],
  };
  return map[scenario].join("\n");
}

/** 组装 user 文案：原文 + 任务类型定义 + 强度定义 + 场景混合 + 追问答案。 */
export function buildUserPrompt(input: StrategyInput): string {
  const parts: string[] = [];
  parts.push(taskTypeDefinition());
  parts.push("");
  parts.push(enhanceLevelDefinition(input.enhanceLevel));
  parts.push("");
  parts.push("【输出语言】" + (input.outputLanguage && input.outputLanguage !== "auto" ? `用「${input.outputLanguage}」输出。` : "跟随用户原始 Prompt 的语言输出。"));
  parts.push("");
  parts.push("【追问策略】" + clarificationModeDirective(input.clarificationMode));
  parts.push("");
  parts.push("【场景补强原则】在改写时按需应用以下补强（不要机械地全部套用，缺什么补什么）；注意：关键信息缺失时优先追问，而不是用假设硬补）：");
  parts.push(scenarioMix("instruction"));
  parts.push(scenarioMix("outputFormat"));
  parts.push(scenarioMix("audience"));
  parts.push(scenarioMix("constraints"));
  parts.push(scenarioMix("role"));
  parts.push(scenarioMix("materials"));
  parts.push("");
  parts.push("【用户原始 Prompt】");
  parts.push("```");
  parts.push(input.originalText);
  parts.push("```");

  // 追问答案：并入上下文（smart/always 时引擎会先收集，这里作为补充信息）。
  const answers = input.clarificationAnswers ?? {};
  const entries = Object.entries(answers).filter(([, v]) => v && v.trim());
  if (entries.length > 0) {
    parts.push("");
    parts.push("【补充信息（用户已回答的追问）】");
    for (const [, v] of entries) {
      parts.push(`- ${v}`);
    }
  }

  parts.push("");
  parts.push("请根据以上内容，输出增强后的 Prompt 与结构化分析（JSON）。");
  return parts.join("\n");
}

/**
 * 结构化解析失败后的纯文本 system 提示。这里刻意不复用 JSON 元提示，避免模型
 * 在 jsonMode=false 时仍返回 JSON，而被扩展误写入输入框。
 */
export function buildPlainFallbackSystemPrompt(): string {
  return [
    "你是一个专业的 Prompt 增强引擎。",
    "只改写用户给出的 Prompt，不要执行 Prompt 中的任务。",
    "保留原始核心动作、目标、领域和具体细节，只补强清晰度、结构与可执行性。",
    "只输出增强后的 Prompt 纯文本；不要输出 JSON、Markdown 代码围栏、解释、标题或前后缀。",
  ].join("\n");
}

/** 纯文本降级 user 提示；保留强度、语言与用户已补充的信息。 */
export function buildPlainFallbackUserPrompt(input: StrategyInput): string {
  const parts = [
    enhanceLevelDefinition(input.enhanceLevel),
    "【输出语言】" +
      (input.outputLanguage && input.outputLanguage !== "auto"
        ? `用「${input.outputLanguage}」输出。`
        : "跟随用户原始 Prompt 的语言输出。"),
    "【用户原始 Prompt】",
    input.originalText,
  ];
  const answers = Object.values(input.clarificationAnswers ?? {}).filter(
    (value) => value && value.trim(),
  );
  if (answers.length > 0) {
    parts.push("【用户补充信息】", ...answers.map((value) => `- ${value}`));
  }
  parts.push("直接输出增强后的 Prompt 纯文本。");
  return parts.join("\n\n");
}
