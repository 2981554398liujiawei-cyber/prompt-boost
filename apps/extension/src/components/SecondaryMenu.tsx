/**
 * SecondaryMenu：Prompt Boost 二级菜单（Stage 6）。
 *
 * 结构（最深两级）：
 *   根菜单：增强模式 / 任务类型 / 自动追问 / Prompt 评分 / ⚙ API 设置
 *   子面板：增强模式选择器 / 任务类型选择器 / 自动追问选择器 / 评分详情
 *
 * 交互契约：
 *   - 焦点移出菜单后关闭（由 BoostButton 在 Shadow DOM 内部处理）。
 *   - Esc 关闭（BoostButton 处理）。
 *   - Tab / 方向键 / Enter / Space 键盘导航。
 *   - 深色/浅色由 Shadow DOM :host[data-theme] 驱动。
 *   - 不超过 viewport（固定定位 + 视口钳制）。
 *   - 不改变 ChatGPT 输入区域高度（绝对定位浮层）。
 */
import { useRef, useEffect, type ReactNode } from "react";
import {
  EXTENSION_VERSION,
  type ClarificationMode,
  type EnhanceLevel,
  type ScoreDimensionKey,
  type TaskType,
} from "@prompt-boost/shared";
import type { MenuPane, PromptScoreView, TaskTypeDisplay } from "../content/types.js";
import type { BoostRequestSettings } from "../content/controller.js";

export const ENHANCE_LEVEL_OPTIONS: Array<{ value: EnhanceLevel; label: string; hint: string }> = [
  { value: "quick", label: "快速", hint: "轻量整理，尽量保持原文" },
  { value: "deep", label: "深度", hint: "补齐目标、上下文、约束与输出要求" },
  { value: "expert", label: "专家", hint: "重构任务、补齐关键假设与质量标准" },
];

export const TASK_TYPE_OPTIONS: Array<{ value: TaskType | "auto"; label: string }> = [
  { value: "auto", label: "自动识别" },
  { value: "writing", label: "写作" },
  { value: "coding", label: "编程" },
  { value: "business", label: "商业" },
  { value: "analysis", label: "分析" },
  { value: "research", label: "研究" },
  { value: "learning", label: "学习" },
  { value: "translation", label: "翻译" },
  { value: "planning", label: "规划" },
  { value: "creative", label: "创意" },
  { value: "general", label: "通用" },
];

export const CLARIFICATION_OPTIONS: Array<{
  value: ClarificationMode;
  label: string;
  hint: string;
}> = [
  { value: "off", label: "关闭", hint: "不追问，直接增强" },
  { value: "smart", label: "智能", hint: "信息不足时追问关键问题" },
  { value: "always", label: "总是", hint: "深度/专家模式允许提出最多 3 个问题" },
];

export interface SecondaryMenuProps {
  pane: MenuPane;
  settings: BoostRequestSettings;
  score?: PromptScoreView;
  scoreStale?: boolean;
  taskTypeDisplay: TaskTypeDisplay;
  detectedTaskType?: string;
  onSetPane: (pane: MenuPane) => void;
  onSetSetting: <K extends keyof BoostRequestSettings>(
    field: K,
    value: BoostRequestSettings[K],
  ) => void;
  onOpenSettings: () => void;
  /** 主动重新评分（离线启发式 /v1/analyze；用于过期评分刷新）。 */
  onRequestScore?: () => void;
}

/** 评分来源文案（不暴露工程字段）。 */
function scoreSourceLabel(source: "llm" | "heuristic_fallback"): string {
  return source === "llm" ? "AI 分析" : "本地估算";
}

/** 增强模式当前值文案。 */
function enhanceLevelLabel(v: string): string {
  return ENHANCE_LEVEL_OPTIONS.find((o) => o.value === v)?.label ?? "深度";
}

/** 任务类型当前值文案。 */
function taskTypeLabel(v: string): string {
  return TASK_TYPE_OPTIONS.find((o) => o.value === v)?.label ?? "自动识别";
}

/** 追问模式当前值文案。 */
function clarificationLabel(v: string): string {
  return CLARIFICATION_OPTIONS.find((o) => o.value === v)?.label ?? "智能";
}

/** 统一单选行：role=menuitemradio + Tab 导航 + Enter/Space 选择。 */
function RadioRow({
  label,
  checked,
  onSelect,
}: {
  label: string;
  checked: boolean;
  onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={`pb-menu-item pb-radio-row${checked ? " pb-radio-checked" : ""}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation();
          onSelect();
        }
      }}
    >
      <span className="pb-radio-dot">{checked ? "●" : "○"}</span>
      <span className="pb-radio-label">{label}</span>
    </button>
  );
}

/** 可进入子面板的行（带 ›）。 */
function NavRow({
  label,
  value,
  stale,
  active,
  onOpen,
}: {
  label: string;
  value: ReactNode;
  stale?: boolean;
  active?: boolean;
  onOpen: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup="menu"
      aria-expanded={active}
      className={`pb-menu-item pb-nav-row${active ? " pb-nav-active" : ""}`}
      onMouseEnter={onOpen}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " " || e.key === "ArrowRight") {
          e.preventDefault();
          e.stopPropagation();
          onOpen();
        }
      }}
    >
      <span className="pb-nav-label">{label}</span>
      <span className="pb-nav-value" data-stale={stale ? "true" : undefined}>
        {value}
      </span>
      <span className="pb-nav-arrow">›</span>
    </button>
  );
}

function EnhanceLevelPane({
  settings,
  onSetSetting,
}: Pick<SecondaryMenuProps, "settings" | "onSetSetting">): ReactNode {
  return (
    <div role="menu" className="pb-menu pb-submenu">
      <div className="pb-menu-title">增强模式</div>
      {ENHANCE_LEVEL_OPTIONS.map((o) => (
        <div key={o.value}>
          <RadioRow
            label={o.label}
            checked={settings.enhanceLevel === o.value}
            onSelect={() => onSetSetting("enhanceLevel", o.value)}
          />
          <div className="pb-radio-hint">{o.hint}</div>
        </div>
      ))}
    </div>
  );
}

function TaskTypePane({
  settings,
  onSetSetting,
}: Pick<SecondaryMenuProps, "settings" | "onSetSetting">): ReactNode {
  return (
    <div role="menu" className="pb-menu pb-submenu">
      <div className="pb-menu-title">任务类型</div>
      {TASK_TYPE_OPTIONS.map((o) => (
        <RadioRow
          key={o.value}
          label={o.label}
          checked={settings.taskType === o.value}
          onSelect={() => onSetSetting("taskType", o.value)}
        />
      ))}
    </div>
  );
}

function ClarificationPane({
  settings,
  onSetSetting,
}: Pick<SecondaryMenuProps, "settings" | "onSetSetting">): ReactNode {
  return (
    <div role="menu" className="pb-menu pb-submenu">
      <div className="pb-menu-title">自动追问</div>
      {CLARIFICATION_OPTIONS.map((o) => (
        <div key={o.value}>
          <RadioRow
            label={o.label}
            checked={settings.clarificationMode === o.value}
            onSelect={() => onSetSetting("clarificationMode", o.value)}
          />
          <div className="pb-radio-hint">{o.hint}</div>
        </div>
      ))}
    </div>
  );
}

/** 评分详情面板（含 8 维、建议、来源）。 */
function ScorePane({
  score,
  scoreStale: stale,
  onRequestScore,
}: Pick<SecondaryMenuProps, "score" | "scoreStale" | "onRequestScore">): ReactNode {
  const dims = score?.dimensions ?? {};
  const dimLabels: Record<ScoreDimensionKey, string> = {
    objective: "目标明确度",
    context: "背景信息",
    audience: "目标受众",
    outputFormat: "输出格式",
    constraints: "限制条件",
    role: "专业视角",
    materials: "必要素材",
    actionability: "可执行性",
  };
  const weights: Record<ScoreDimensionKey, number> = {
    objective: 20,
    context: 15,
    audience: 10,
    outputFormat: 15,
    constraints: 10,
    role: 10,
    materials: 10,
    actionability: 10,
  };

  if (stale) {
    return (
      <div role="menu" className="pb-menu pb-submenu">
        <div className="pb-menu-title">Prompt 评分</div>
        <div className="pb-score-stale">
          当前评分来自上一次 Boost 前的 Prompt。
          <br />
          输入已修改，评分已过期。
          <br />
          再次 Boost 后会更新。
        </div>
        {onRequestScore && (
          <button
            type="button"
            role="menuitem"
            className="pb-menu-item pb-rescore-row"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRequestScore();
            }}
          >
            重新评分
          </button>
        )}
      </div>
    );
  }

  return (
    <div role="menu" className="pb-menu pb-submenu pb-score-pane">
      <div className="pb-menu-title">Prompt 评分</div>
      <div className="pb-score-total">
        {score?.total ?? 0}
        <span className="pb-score-total-max"> / 100</span>
      </div>
      {Object.entries(dimLabels).map(([key, label]) => {
        const k = key as ScoreDimensionKey;
        const v = dims[k];
        const w = weights[k] ?? 10;
        const shown = v == null ? 0 : Math.round((v / 100) * w);
        return (
          <div key={key} className="pb-score-row">
            <span>{label}</span>
            <span className="pb-score-row-val">
              {shown} / {w}
            </span>
          </div>
        );
      })}
      {score && score.missing.length > 0 && (
        <>
          <div className="pb-dim-title">建议补充：</div>
          {score.missing.map((m) => (
            <p key={m} className="pb-missing">
              - {m}
            </p>
          ))}
        </>
      )}
      {score && score.suggestions.length > 0 && (
        <>
          <div className="pb-dim-title">优化建议：</div>
          <p className="pb-hint">{score.suggestions.join("；")}</p>
        </>
      )}
      <div className="pb-score-source">
        评分来源：{score ? scoreSourceLabel(score.scoreSource) : "本地估算"}
      </div>
    </div>
  );
}

/** 根菜单。 */
function RootMenu(props: SecondaryMenuProps): ReactNode {
  const { settings, score, scoreStale, taskTypeDisplay, onSetPane, onOpenSettings } = props;

  const taskValue =
    taskTypeDisplay.mode === "manual"
      ? taskTypeLabel(taskTypeDisplay.value)
      : taskTypeDisplay.detected
        ? `自动 · ${taskTypeLabel(taskTypeDisplay.detected)}`
        : "自动";

  const scoreValue = score ? (scoreStale ? "已过期" : `${score.total}/100`) : "增强后查看";

  return (
    <div role="menu" className="pb-menu pb-root-menu">
      <div className="pb-menu-title">
        Prompt Boost <span className="pb-menu-version">v{EXTENSION_VERSION}</span>
      </div>
      <NavRow
        label="增强模式"
        value={enhanceLevelLabel(settings.enhanceLevel)}
        active={props.pane === "enhanceLevel"}
        onOpen={() => onSetPane("enhanceLevel")}
      />
      <NavRow
        label="任务类型"
        value={taskValue}
        active={props.pane === "taskType"}
        stale={
          taskTypeDisplay.mode === "auto" &&
          !taskTypeDisplay.detected &&
          Boolean((props as { detectedTaskType?: string }).detectedTaskType)
        }
        onOpen={() => onSetPane("taskType")}
      />
      <NavRow
        label="自动追问"
        value={clarificationLabel(settings.clarificationMode)}
        active={props.pane === "clarification"}
        onOpen={() => onSetPane("clarification")}
      />
      <NavRow
        label="Prompt 评分"
        value={scoreValue}
        active={props.pane === "score"}
        onOpen={() => onSetPane("score")}
      />
      <div className="pb-menu-sep" />
      <button
        type="button"
        role="menuitem"
        className="pb-menu-item pb-settings-row"
        onMouseEnter={() => onSetPane("root")}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onOpenSettings();
        }}
      >
        ⚙ API 设置
      </button>
    </div>
  );
}

export function SecondaryMenu(props: SecondaryMenuProps): ReactNode {
  const { pane } = props;
  const rootRef = useRef<HTMLDivElement>(null);

  // 首次打开根菜单时聚焦第一项；子面板切换不抢走鼠标焦点。
  useEffect(() => {
    if (pane !== "root") return;
    const el = rootRef.current?.querySelector<HTMLElement>(".pb-root-menu button");
    el?.focus();
  }, [pane]);

  if (pane === null) return null;

  return (
    <div
      ref={rootRef}
      className="pb-menu-wrap"
      onMouseLeave={() => {
        if (pane !== "root") props.onSetPane("root");
      }}
    >
      <RootMenu {...props} />
      {pane === "enhanceLevel" && (
        <EnhanceLevelPane settings={props.settings} onSetSetting={props.onSetSetting} />
      )}
      {pane === "taskType" && (
        <TaskTypePane settings={props.settings} onSetSetting={props.onSetSetting} />
      )}
      {pane === "clarification" && (
        <ClarificationPane settings={props.settings} onSetSetting={props.onSetSetting} />
      )}
      {pane === "score" && (
        <ScorePane
          score={props.score}
          scoreStale={props.scoreStale}
          onRequestScore={props.onRequestScore}
        />
      )}
    </div>
  );
}
