/**
 * Prompt 评分（Prompt Analyzer 的纯函数部分，MVP 兜底）。
 *
 * 评分规则（产品定义）：
 *   total = Σ (dimension * weight) / 100
 * 程序负责计算总分 —— 任何来源（模型或启发式）给出的都是各维度 0–100 的分数，
 * 总分永远由本模块加权得出，不允许模型直接输出一个数字。
 *
 * 启发式维度评分（无模型可用时的兜底）：
 * - objective 20：目标动词（帮/请/分析/写/生成…）+ 任务名词。
 * - context 15：上下文提示词（背景/我们/我的/公司/目前/现在/面向…）字数占比。
 * - audience 10：受众提示词（受众/用户/读者/面向/给…）。
 * - outputFormat 15：格式提示词（表格/列表/JSON/Markdown/标题/字数/段落/大纲/结构/代码/括号）。
 * - constraints 10：限制提示词（尽量/不/只/保持/字数/时间/预算/格式/语言/约束/限制/不要）。
 * - role 10：角色提示词（扮演/作为/你是一名/你是…）。
 * - materials 10：素材提示词（数据/内容/材料/信息/资料/输入/例子/参考）。
 * - actionability 10：可执行性启发（明确的执行动作+产出）。
 */
import {
  MAX_INPUT_LENGTH,
  SCORE_WEIGHTS,
  type ScoreDimensions,
} from "@prompt-boost/shared";

export interface HeuristicScoreResult {
  dimensions: ScoreDimensions;
  total: number;
  missing: string[];
  suggestions: string[];
}

const DIMENSION_LABELS: Record<keyof ScoreDimensions, string> = {
  objective: "目标",
  context: "背景信息",
  audience: "目标受众",
  outputFormat: "输出格式",
  constraints: "限制条件",
  role: "角色视角",
  materials: "数据/素材",
  actionability: "可执行性",
};

/** 由各维度加权计算总分（0–100，四舍五入）。 */
export function computeTotalScore(dimensions: ScoreDimensions): number {
  let weighted = 0;
  for (const [key, weight] of Object.entries(SCORE_WEIGHTS)) {
    const dim = dimensions[key as keyof ScoreDimensions];
    const clamped = Math.min(100, Math.max(0, Math.round(dim)));
    weighted += clamped * weight;
  }
  return Math.round(weighted / 100);
}

const clamp = (n: number): number => Math.min(100, Math.max(0, Math.round(n)));

const containsAny = (text: string, tokens: string[]): boolean => {
  const lower = text.toLowerCase();
  return tokens.some((t) => lower.includes(t));
};

/** 统计给定 token 在文本中出现的次数（中文直接匹配，英文小写匹配）。 */
function countTokens(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  return tokens.reduce((sum, t) => sum + (lower.includes(t) ? 1 : 0), 0);
}

/**
 * 启发式维度评分。返回值仅为兜底；模型分类可用时，
 * 由 local-agent 将模型输出的维度判断传入 computeTotalScore。
 */
export function heuristicScore(text: string): HeuristicScoreResult {
  const objective = containsAny(text, [
    "帮",
    "请",
    "写",
    "生成",
    "分析",
    "设计",
    "制定",
    "翻译",
    "优化",
    "总结",
    "修改",
    "创建",
    "解释",
    "制作",
  ])
    ? 70 + countTokens(text, ["帮", "请", "写", "生成", "分析", "设计", "制定", "翻译", "优化", "总结", "修改", "创建", "解释", "制作"]) * 10
    : 40;

  const contextRatio = Math.min(1, text.length / 120);
  // 修复 P：长度占比满分从 40 提到 50（50+50=100），使 context 维度可满分，
  // 加权总分可达 100（修复前封顶 99）。
  const context =
    (countTokens(text, ["背景", "我们", "我的", "公司", "目前", "现在", "面向", "对象", "场景", "情况"]) > 0 ? 50 : 0) +
    Math.round(contextRatio * 50);

  const audience = containsAny(text, ["受众", "用户", "读者", "面向", "给", "对"]) ? 70 : 20;

  const outputFormat = containsAny(text, [
    "表格",
    "列表",
    "json",
    "markdown",
    "标题",
    "字数",
    "段落",
    "大纲",
    "结构",
    "代码",
    "输出格式",
    "bullet",
    "outline",
  ])
    ? 80
    : 20;

  const constraints = containsAny(text, [
    "尽量",
    "不",
    "只",
    "保持",
    "字数",
    "时间",
    "预算",
    "格式",
    "语言",
    "约束",
    "限制",
    "不要",
    "不超过",
  ])
    ? 70
    : 25;

  const role = containsAny(text, ["扮演", "作为", "你是一名", "你是", "充当"]) ? 80 : 20;

  const materials = containsAny(text, ["数据", "内容", "材料", "信息", "资料", "输入", "例子", "参考", "根据"]) ? 60 : 25;

  const lengthScore = Math.min(100, Math.round((text.length / 200) * 60) + 20);
  const actionability = clamp(lengthScore + (containsAny(text, ["步骤", "计划", "方案", "表格", "清单"]) ? 20 : 0));

  const dimensions: ScoreDimensions = {
    objective: clamp(objective),
    context: clamp(context),
    audience: clamp(audience),
    outputFormat: clamp(outputFormat),
    constraints: clamp(constraints),
    role: clamp(role),
    materials: clamp(materials),
    actionability,
  };

  const total = computeTotalScore(dimensions);

  const missing: string[] = [];
  const suggestions: string[] = [];
  if (dimensions.objective < 60) {
    missing.push("明确的目标");
    suggestions.push("用一句动词开头写明你要什么，例如「制定…方案」「编写…代码」。");
  }
  if (dimensions.context < 60) {
    missing.push("背景信息");
    suggestions.push("补充背景：当前情况、已尝试过什么、为什么需要。");
  }
  if (dimensions.audience < 60) {
    missing.push("目标受众");
    suggestions.push("说明产出给谁看（客户、团队、读者、非技术用户…）。");
  }
  if (dimensions.outputFormat < 60) {
    missing.push("输出格式");
    suggestions.push("指定格式：表格 / 列表 / 代码 / Markdown 标题 / 字数范围。");
  }
  if (dimensions.constraints < 60) {
    missing.push("限制条件");
    suggestions.push("补充约束：时间、预算、字数、风格、技术栈或禁止事项。");
  }
  if (dimensions.role < 60) {
    missing.push("角色或专业视角");
    suggestions.push("指定一个对任务有帮助的视角，例如「你是一名产品经理」。");
  }
  if (dimensions.materials < 60) {
    missing.push("必要数据或素材");
    suggestions.push("如果依赖特定信息，请提供数据、文档或示例输入。");
  }
  if (dimensions.actionability < 60) {
    missing.push("可执行步骤");
    suggestions.push("要求给出步骤、计划或清单，让输出可落地执行。");
  }

  return { dimensions, total, missing, suggestions };
}

/** 由任意来源的维度分数构建缺失项列表（供评分展示）。 */
export function buildScoreReport(dimensions: ScoreDimensions): {
  missing: string[];
  suggestions: string[];
} {
  const missing: string[] = [];
  const suggestions: string[] = [];
  for (const key of Object.keys(SCORE_WEIGHTS) as Array<keyof ScoreDimensions>) {
    if (dimensions[key] < 60) {
      missing.push(DIMENSION_LABELS[key]);
    }
  }
  // 建议在 heuristicScore 中逐条生成；这里给出通用兜底建议。
  if (missing.length > 0) {
    suggestions.push(`建议补充：${missing.join("、")}。`);
  }
  return { missing, suggestions };
}

/** 校验外部（模型）返回的维度对象：字段齐全、0–100 整数。 */
export function sanitizeDimensions(input: Partial<ScoreDimensions>): ScoreDimensions {
  const out = {} as ScoreDimensions;
  for (const key of Object.keys(SCORE_WEIGHTS) as Array<keyof ScoreDimensions>) {
    const raw = input[key];
    out[key] = typeof raw === "number" && Number.isFinite(raw) ? clamp(raw) : 0;
  }
  return out;
}

/** 输入上限（供校验层引用）。 */
export const MAX_SCORED_INPUT_LENGTH = MAX_INPUT_LENGTH;
