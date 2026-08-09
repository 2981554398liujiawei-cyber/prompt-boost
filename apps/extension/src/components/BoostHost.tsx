/**
 * BoostHost：挂在 Shadow DOM 里的 React 根组件。
 * 负责任务按钮、二级菜单、浮层（错误、评分、追问、冲突、撤销 toast）的渲染。
 * 真正的业务由 BoostController（content/controller.ts）驱动。
 */
import { useEffect, useState } from "react";
import type { BoostState } from "@prompt-boost/shared";
import { BoostButton, type BoostButtonState } from "./BoostButton.js";
import { SecondaryMenu } from "./SecondaryMenu.js";
import type {
  LastBoostResult,
  MenuPane,
  PromptScoreView,
  TaskTypeDisplay,
} from "../content/types.js";
import type { BoostRequestSettings } from "../content/controller.js";

export interface BoostHostProps {
  state: BoostState;
  errorMessage?: string;
  /** 评分结果（评分面板）。 */
  score?: PromptScoreView;
  scoreStale?: boolean;
  /** 澄清问题列表。 */
  clarifications?: Array<{ id: string; question: string; reason: string; required: boolean }>;
  /** 澄清面板当前答案。 */
  clarificationAnswers?: Record<string, string>;
  /** 最近一次增强结果（冲突/撤销）。 */
  lastBoostResult?: LastBoostResult;
  /** 冲突状态下待决定的增强文本。 */
  conflictEnhancedText?: string;
  /** 二级菜单层级。 */
  menuPane: MenuPane;
  settings: BoostRequestSettings;
  taskTypeDisplay: TaskTypeDisplay;
  detectedTaskType?: string;
  canBoost: boolean;
  onBoost: () => void;
  onDismiss: () => void;
  onOpenSettings: () => void;
  onClarificationAnswer: (id: string, value: string) => void;
  onClarificationSubmit: () => void;
  onClarificationSkip: () => void;
  onSetPane: (pane: MenuPane) => void;
  onSetSetting: <K extends keyof BoostRequestSettings>(field: K, value: BoostRequestSettings[K]) => void;
  onCancelConflict: () => void;
  onCopyConflict: () => void;
  onOverwriteConflict: () => void;
  onUndo: () => void;
  /** 主动重新评分（ScorePane stale 分支的「重新评分」按钮）。 */
  onRequestScore?: () => void;
}

function mapToButtonState(state: BoostState): BoostButtonState {
  switch (state) {
    case "reading":
    case "analyzing":
    case "clarifying":
    case "enhancing":
    case "writing":
      return "loading";
    case "success":
      return "success";
    case "error":
    case "conflict":
      return "error";
    default:
      return "idle";
  }
}

export function BoostHost(props: BoostHostProps) {
  const {
    state,
    errorMessage,
    score,
    scoreStale,
    clarifications = [],
    clarificationAnswers = {},
    lastBoostResult,
    conflictEnhancedText,
    menuPane,
    settings,
    taskTypeDisplay,
    detectedTaskType,
    canBoost,
    onBoost,
    onDismiss,
    onOpenSettings,
    onClarificationAnswer,
    onClarificationSubmit,
    onClarificationSkip,
    onSetPane,
    onSetSetting,
    onCancelConflict,
    onCopyConflict,
    onOverwriteConflict,
    onUndo,
    onRequestScore,
  } = props;

  const buttonState = mapToButtonState(state);
  // 撤销 toast：成功写回后显示「已增强 [撤销]」，5s 后自动消失。
  const [undoVisible, setUndoVisible] = useState(false);
  const [undoTimer, setUndoTimer] = useState<number | undefined>(undefined);

  // lastBoostResult 更新（新的增强写回）→ 显示 toast 并计时关闭。
  // 修复 I：只在 success（真正写回成功）时显示——clarifying/conflict 分支也会写
  // lastBoostResult，但那些是 overlay，不应弹出「已增强 撤销」toast。
  useEffect(() => {
    if (!lastBoostResult || state !== "success") return;
    setUndoVisible(true);
    window.clearTimeout(undoTimer);
    const t = window.setTimeout(() => {
      setUndoVisible(false);
      setUndoTimer(undefined);
    }, 5000);
    setUndoTimer(t);
    return () => window.clearTimeout(t);
  }, [lastBoostResult?.timestamp]);

  useEffect(() => () => window.clearTimeout(undoTimer), [undoTimer]);

  const handleBoost = (): void => {
    window.clearTimeout(undoTimer);
    setUndoTimer(undefined);
    setUndoVisible(false);
    onBoost();
  };

  return (
    <div className="pb-root" data-state={state}>
      <BoostButton
        state={buttonState}
        disabled={!canBoost}
        onBoost={handleBoost}
        onOpenMenu={() => onSetPane(menuPane ? null : "root")}
        ariaExpanded={Boolean(clarifications.length || score)}
        menuOpen={menuPane !== null}
        menu={
          <SecondaryMenu
            pane={menuPane}
            settings={settings}
            score={score}
            scoreStale={scoreStale}
            taskTypeDisplay={taskTypeDisplay}
            detectedTaskType={detectedTaskType}
            onSetPane={onSetPane}
            onSetSetting={onSetSetting}
            onOpenSettings={onOpenSettings}
            onRequestScore={onRequestScore}
          />
        }
        onMenuClose={() => onSetPane(null)}
      />

      {state === "error" && errorMessage && (
        <div className="pb-banner" data-kind="error">
          <strong>增强失败：</strong>
          {errorMessage}
          <button className="pb-close" onClick={onDismiss}>
            ✕
          </button>
        </div>
      )}

      {/* Stage 7：追问面板 */}
      {state === "clarifying" && clarifications.length > 0 && (
        <div className="pb-overlay-backdrop">
          <div className="pb-panel">
            <button className="pb-close" onClick={onDismiss}>
              ✕
            </button>
            <h3>为了让 Prompt 更准确，可以补充：</h3>
            {clarifications.map((q, i) => (
              <div key={q.id} className="pb-score-row">
                <label>
                  {i + 1}. {q.question}
                  {q.required && <span style={{ color: "var(--pb-danger)" }}> *</span>}
                </label>
                <input
                  type="text"
                  value={clarificationAnswers[q.id] ?? ""}
                  onChange={(e) => onClarificationAnswer(q.id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onClarificationSubmit();
                  }}
                />
              </div>
            ))}
            <div className="pb-conflict-actions">
              <button className="pb-trigger" onClick={onDismiss}>
                取消
              </button>
              <button className="pb-trigger" onClick={onClarificationSkip}>
                使用默认假设
              </button>
              <button className="pb-boost" onClick={onClarificationSubmit}>
                回答并增强
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 评分面板 */}
      {score && state !== "clarifying" && state !== "conflict" && (
        <div className="pb-overlay-backdrop">
          <div className="pb-panel">
            <button className="pb-close" onClick={onDismiss}>
              ✕
            </button>
            <h3>Prompt 评分：{score.total}/100</h3>
            <div className="pb-score-bar">
              <div className="pb-score-fill" style={{ width: `${score.total}%` }} />
            </div>
            <div className="pb-dim-title">需要补充：</div>
            {score.missing.length > 0 ? (
              score.missing.map((m) => (
                <p key={m} className="pb-missing">
                  - {m}
                </p>
              ))
            ) : (
              <p className="pb-missing">无缺失项，结构较完整。</p>
            )}
            {score.suggestions.length > 0 && (
              <>
                <div className="pb-dim-title">优化建议：</div>
                <p className="pb-hint">{score.suggestions.join("；")}</p>
              </>
            )}
          </div>
        </div>
      )}

      {/* 冲突面板：请求期间用户修改了输入 */}
      {state === "conflict" && conflictEnhancedText && (
        <div className="pb-overlay-backdrop">
          <div className="pb-panel">
            <button className="pb-close" onClick={onCancelConflict}>
              ✕
            </button>
            <h3>你在增强过程中修改了输入内容。</h3>
            <p className="pb-hint">为避免覆盖你的编辑，请选择处理方式：</p>
            <div className="pb-conflict-actions">
              <button className="pb-trigger" onClick={onCancelConflict}>
                取消
              </button>
              <button className="pb-trigger" onClick={onCopyConflict}>
                复制增强结果
              </button>
              <button className="pb-boost" onClick={onOverwriteConflict}>
                覆盖当前内容
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 撤销 toast */}
      {undoVisible && lastBoostResult && (
        <div className="pb-toast" role="status">
          <span>已增强</span>
          <button
            type="button"
            className="pb-toast-undo"
            onClick={() => {
              onUndo();
              window.clearTimeout(undoTimer);
              setUndoTimer(undefined);
              setUndoVisible(false);
            }}
          >
            撤销
          </button>
        </div>
      )}
    </div>
  );
}
