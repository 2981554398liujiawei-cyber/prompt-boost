/** content script 内部类型。 */
import type { ScoreDimensionKey, ScoreSource } from "@prompt-boost/shared";

/**
 * 评分面板展示结构。
 * 保留 8 维分数、来源、评分对应的原文快照，供二级菜单展示与过期判断。
 */
export interface PromptScoreView {
  total: number;
  missing: string[];
  suggestions: string[];
  /** 8 维明细（菜单详情页展示）。 */
  dimensions: Partial<Record<ScoreDimensionKey, number>>;
  /** 评分来源：llm → AI 分析；heuristic_fallback → 本地估算。 */
  scoreSource: ScoreSource;
  /** 评分对应的原文快照（用于过期检测）。 */
  scoredOriginalText: string;
}

/**
 * 增强流程的上下文，供并发保护与撤销使用。
 */
export interface BoostSession {
  requestId: string;
  originalText: string;
  startedAt: number;
}

/** 最近一次增强结果（用于撤销、评分展示、冲突保护）。 */
export interface LastBoostResult {
  originalText: string;
  enhancedText: string;
  analysis: import("@prompt-boost/shared").PromptAnalysis;
  assumptions: string[];
  timestamp: number;
}

/** 二级菜单中「任务类型」的展示形态。 */
export type TaskTypeDisplay =
  | { mode: "auto"; detected?: string }
  | { mode: "manual"; value: string };

/** 二级菜单的展开层级（最深两级：根菜单 → 子项面板）。 */
export type MenuPane =
  | "root"
  | "enhanceLevel"
  | "taskType"
  | "clarification"
  | "score"
  | null;
