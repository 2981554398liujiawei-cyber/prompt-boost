/**
 * 离线任务分类器（Task Classifier 的纯函数部分，MVP 兜底）。
 *
 * 真实分类最终由 local-agent 调用模型完成（结构化 JSON）。
 * 在本地服务不可用、或模型调用失败时，使用此规则分类器保证基础可用性，
 * 并用于单元测试中的确定性断言。
 *
 * 策略：
 * - 中英文关键词加权命中，按任务组累计得分。
 * - 词典命中翻倍（“翻译成英语”）。
 * - 翻译命中时，翻译任务优先于其关键词落入的其它组。
 * - 未命中或并列时返回 general，置信度取归一化得分。
 */
import type { ClassificationResult, TaskType } from "@prompt-boost/shared";

export type RuleTaskGroup = Exclude<TaskType, "general">;

interface RuleEntry {
  /** 上下文名词/通用关键词，命中 +1。 */
  zh: string[];
  en: string[];
  /** 强信号动作词，命中 +2（如“分析/写/翻译”）。避免与上下文名词并列时丢失语义。 */
  strong: string[];
}

const KEYWORDS: Record<RuleTaskGroup, RuleEntry> = {
  writing: {
    zh: ["文案", "文章", "邮件", "作文", "博客", "标题", "脚本", "报告", "摘要", "总结", "扩写", "缩写"],
    en: ["compose", "draft", "essay", "email", "copy", "article", "rewrite", "polish", "summarize", "blog", "headline", "script", "poem", "caption", "paragraph"],
    strong: ["写", "撰写", "起草", "润色", "改写"],
  },
  coding: {
    zh: ["函数", "组件", "接口", "报错", "调试", "算法", "登录页面", "sql", "js", "python", "typescript", "react", "node"],
    en: ["component", "api", "endpoint", "bug", "error", "debug", "algorithm", "program", "script", "sql", "python", "typescript", "react", "node", "login", "refactor"],
    strong: ["代码", "开发", "实现功能", "implement"],
  },
  business: {
    zh: ["推广", "营销", "商业", "市场", "销售", "运营", "品牌", "预算", "报价", "融资", "竞品", "增长", "获客", "投放", "活动策划"],
    en: ["marketing", "sales", "market", "campaign", "brand", "growth", "strategy", "budget", "pricing", "pitch", "ad", "customer", "conversion", "proposal"],
    strong: ["方案", "计划书", "企划", "商业模式", "business plan", "go-to-market", "gtm"],
  },
  analysis: {
    zh: ["评估", "对比", "比较", "解读", "复盘", "洞察", "指标", "数据", "趋势", "优劣势", "可行性", "绩效"],
    en: ["assess", "evaluate", "compare", "interpret", "review", "insight", "metrics", "trend", "pros and cons", "feasibility", "swot"],
    strong: ["分析"],
  },
  research: {
    zh: ["调研", "查找", "文献", "资料", "溯源", "考证", "搜集", "论文", "引用", "来源"],
    en: ["literature", "sources", "cite", "references", "find", "investigate", "survey", "paper", "evidence"],
    strong: ["研究", "research"],
  },
  learning: {
    zh: ["教程", "入门", "掌握", "练习", "讲解", "理解", "复习", "课程", "备考", "教会我"],
    en: ["tutorial", "teach", "explain", "understand", "practice", "beginner", "course", "lesson", "exercise", "guide"],
    strong: ["学习", "learn", "study"],
  },
  translation: {
    // 不含单字「译」：会命中「编译/音译」等与翻译无关的词（修复 O）。
    zh: ["译成", "中译英", "英译中"],
    en: ["into english", "into chinese", "translated"],
    strong: ["翻译", "translate"],
  },
  planning: {
    zh: ["安排", "日程", "路线图", "步骤", "流程", "排期", "清单"],
    en: ["schedule", "itinerary", "roadmap", "timeline", "steps", "checklist", "todo", "agenda", "outline"],
    strong: ["计划", "规划", "plan", "planning"],
  },
  creative: {
    zh: ["脑洞", "故事", "小说", "剧本", "点子", "设计", "脑风暴", "灵感", "拟人", "童话"],
    en: ["idea", "brainstorm", "story", "novel", "poem", "imagine", "inspire", "fiction"],
    strong: ["创意", "creative", "design"],
  },
};

const GROUP_ORDER: RuleTaskGroup[] = [
  "translation",
  "coding",
  "writing",
  "business",
  "analysis",
  "research",
  "learning",
  "planning",
  "creative",
];

function scoreGroup(text: string, rule: RuleEntry): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of rule.zh) {
    if (text.includes(kw)) score += 1;
  }
  for (const kw of rule.en) {
    if (lower.includes(kw)) score += 1;
  }
  for (const kw of rule.strong) {
    if (text.includes(kw)) score += 2;
  }
  return score;
}

/** 规则分类：返回最强命中的任务组与得分。 */
function ruleClassify(text: string): { group: RuleTaskGroup | null; score: number } {
  let best: RuleTaskGroup | null = null;
  let bestScore = 0;
  for (const group of GROUP_ORDER) {
    const s = scoreGroup(text, KEYWORDS[group]);
    if (s > bestScore) {
      best = group;
      bestScore = s;
    }
  }
  return { group: bestScore > 0 ? best : null, score: bestScore };
}

/** 归一化置信度：命中越多越确定，封顶 0.95（规则分类不追求 1.0）。 */
function confidence(score: number): number {
  return Math.min(0.95, 0.5 + score * 0.1);
}

/**
 * 离线分类入口。输入为规范化文本。
 * 返回结构化结果；无命中返回 general 且置信度低。
 */
export function classifyTaskType(text: string): ClassificationResult {
  const { group, score } = ruleClassify(text);
  if (!group) {
    return { taskType: "general", confidence: 0.2 };
  }
  return { taskType: group, confidence: confidence(score) };
}
