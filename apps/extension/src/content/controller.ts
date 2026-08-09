/**
 * BoostController：content script 的增强流程状态机。
 *
 * 状态机（Stage 6/7 完整版）：
 *   idle
 *     → reading → analyzing → enhancing → writing → success
 *     → analyzing → clarifying → enhancing → writing → success
 *     → conflict（请求期间用户修改输入，需确认）→ idle / success
 *   任何阶段失败 → error（可关闭 → idle）
 *
 * 并发保护（requestId）：每次 boost 生成新 requestId；旧请求返回时若 requestId
 * 不匹配当前会话则丢弃，绝不覆盖新结果。
 *
 * 冲突保护：请求返回后重新读取输入框，若用户在请求期间修改了内容（≠ originalText），
 * 进入 conflict 状态，由用户选择 取消 / 复制 / 覆盖，默认安全取消。
 *
 * 评分与过期：增强返回后保存 score 与 scoredOriginalText；用户后续编辑输入框时
 * 标记 scoreStale（只做标记，绝不自动调用模型重新评分）。detectedTaskType 同理
 * 标记 detectedStale（"待重新检测"）。
 *
 * Stage 7 追问：clarifying 状态由 analysis.clarificationRequired 触发；
 * 回答后带 clarificationAnswers 二次增强（最多 2 次调用）。
 */
import type { BoostState, PromptAnalysis } from "@prompt-boost/shared";
import type { PlatformAdapter } from "../platform/types.js";
import type {
  BoostSession,
  LastBoostResult,
  MenuPane,
  PromptScoreView,
  TaskTypeDisplay,
} from "./types.js";
import { sendAnalyzeRequest, sendEnhanceRequest } from "./messages.js";
import { aggregateScore, randomUUID } from "./utils.js";

export interface BoostControllerOptions {
  adapter: PlatformAdapter;
  /** 状态变更回调（用于驱动 UI 重渲染）。 */
  onState: (state: BoostState, payload: BoostUiPayload) => void;
  onOpenSettings: () => void;
  /** 通过 background 获取扩展设置（用于构造增强请求与菜单展示）。 */
  getBoostSettings: () => Promise<BoostRequestSettings>;
  /** 持久化设置变更（chrome.storage），返回更新后的设置。 */
  saveSettings?: (patch: Partial<BoostRequestSettings>) => Promise<void>;
}

export interface BoostRequestSettings {
  taskType: string;
  enhanceLevel: string;
  clarificationMode: string;
  outputLanguage: string;
}

/** UI 渲染所需全部状态。 */
export interface BoostUiPayload {
  state: BoostState;
  errorMessage?: string;
  score?: PromptScoreView;
  /** 评分是否过期（用户已改动输入框）。 */
  scoreStale?: boolean;
  /** 最近一次增强后的任务类型（auto 模式展示「自动 · 商业」）。 */
  detectedTaskType?: string;
  /** 最近一次增强结果（Undo / 冲突复制 / 菜单）。 */
  lastBoostResult?: LastBoostResult;
  /** 冲突状态下待用户决定的增强文本。 */
  conflictEnhancedText?: string;
  clarifications: Array<{ id: string; question: string; reason: string; required: boolean }>;
  clarificationAnswers: Record<string, string>;
  /** 二级菜单当前层级。 */
  menuPane: MenuPane;
  /** 当前设置（菜单展示与变更）。 */
  settings: BoostRequestSettings;
  /** 任务类型展示形态。 */
  taskTypeDisplay: TaskTypeDisplay;
}

/** 无追问答复的请求设置。 */
const DEFAULT_SETTINGS: BoostRequestSettings = {
  taskType: "auto",
  enhanceLevel: "deep",
  clarificationMode: "smart",
  outputLanguage: "auto",
};

/**
 * Clarification Gate：程序侧决定是否展示追问 UI（模型只负责语义，程序把关）。
 * - off → 永不追问
 * - quick → 快速档永不追问（quick 只做最小改动，不打断用户）
 * - always → 有追问问题即追问（不依赖 clarificationRequired）
 * - smart → 仅在 clarificationRequired=true 且有问题时追问
 * 与 local-agent/pipeline.ts 中的程序侧派生一致，双重把关。
 */
export function shouldShowClarification(
  mode: string,
  enhanceLevel: string,
  analysis: Pick<PromptAnalysis, "clarificationRequired" | "clarificationQuestions">,
): boolean {
  if (mode === "off") return false;
  if (enhanceLevel === "quick") return false;
  if (mode === "always") return analysis.clarificationQuestions.length > 0;
  if (mode === "smart") return analysis.clarificationRequired === true && analysis.clarificationQuestions.length > 0;
  return false;
}

/** PROMPT_BOOST_DEBUG 诊断日志：只输出非敏感元数据，绝不输出 API Key / 授权 / 完整 prompt / 完整模型响应 / 用户回答。 */
function debugLog(...args: unknown[]): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = (typeof globalThis !== "undefined" && (globalThis as any).process?.env) || {};
    if (env.PROMPT_BOOST_DEBUG === "true") {
      console.debug("[prompt-boost][debug]", ...args);
    }
  } catch {
    // 诊断日志永不抛错。
  }
}

export class BoostController {
  private state: BoostState = "idle";
  private session: BoostSession | null = null;
  private clarifications: BoostUiPayload["clarifications"] = [];
  private clarificationAnswers: Record<string, string> = {};
  private score: PromptScoreView | undefined;
  private lastError: string | undefined;
  private lastBoostResult: LastBoostResult | undefined;
  private conflictEnhancedText: string | undefined;
  private menuPane: MenuPane = null;
  private settings: BoostRequestSettings = { ...DEFAULT_SETTINGS };
  private detectedTaskType: string | undefined;
  private scoreStale = false;
  private detectedStale = false;
  /** 并发：当前生效的 requestId（新 boost 递增，旧返回被忽略）。 */
  private activeRequestId: string | null = null;
  /** 当前 Boost 会话已发起的上游增强调用次数（诊断用）。 */
  private upstreamCallCount = 0;
  private disposed = false;
  private readonly detachInput: () => void;

  constructor(private readonly opts: BoostControllerOptions) {
    // 监听 composer 输入：只用于把评分/检测标记为过期，绝不触发模型调用。
    const onInput = (): void => {
      const text = this.opts.adapter.readInput();
      if (this.score && text !== this.score.scoredOriginalText && !this.scoreStale) {
        this.scoreStale = true;
        this.emit();
      }
      if (this.lastBoostResult && text !== this.lastBoostResult.originalText && !this.detectedStale) {
        this.detectedStale = true;
        this.emit();
      }
    };
    document.addEventListener("input", onInput, true);
    this.detachInput = () => document.removeEventListener("input", onInput, true);
  }

  /** 当前是否可发起新一次 Boost。 */
  get canBoost(): boolean {
    return this.state === "idle" || this.state === "success" || this.state === "error" || this.state === "conflict";
  }

  /** 强制重新渲染当前状态（挂载完成后由 content.ts 调用），并刷新设置。 */
  async refresh(): Promise<void> {
    const s = await this.opts.getBoostSettings();
    this.settings = { ...DEFAULT_SETTINGS, ...s };
    this.emit();
  }

  /** 释放全局监听（卸载 UI 时调用）。 */
  dispose(): void {
    this.disposed = true;
    this.detachInput();
  }

  private emit(): void {
    if (this.disposed) return;
    const taskTypeDisplay: TaskTypeDisplay =
      this.settings.taskType === "auto"
        ? {
            mode: "auto",
            detected: this.detectedTaskType && !this.detectedStale ? this.detectedTaskType : undefined,
          }
        : { mode: "manual", value: this.settings.taskType };
    this.opts.onState(this.state, {
      state: this.state,
      errorMessage: this.lastError,
      score: this.score,
      scoreStale: this.scoreStale,
      detectedTaskType: this.detectedTaskType,
      lastBoostResult: this.lastBoostResult,
      conflictEnhancedText: this.conflictEnhancedText,
      clarifications: this.clarifications,
      clarificationAnswers: this.clarificationAnswers,
      menuPane: this.menuPane,
      settings: this.settings,
      taskTypeDisplay,
    });
  }

  /** 主入口：用户点击 Boost。 */
  async boost(): Promise<void> {
    if (!this.canBoost) return;

    // 先快照输入（冲突检测以点击时刻的原文为基准），再同步持久化设置。
    const composer = this.opts.adapter.findComposer();
    if (!composer) {
      this.fail("Prompt Boost 暂时无法识别 ChatGPT 输入框。");
      return;
    }
    const originalText = this.opts.adapter.readInput();
    if (!originalText.trim()) {
      this.fail("输入内容为空，请先输入文字");
      return;
    }

    // 每次 boost 前同步最新持久化设置（菜单/Options 页的改动在发起时生效；
    // 避免 clarifying 判定等基于陈旧的默认设置）。
    let fresh: BoostRequestSettings;
    try {
      fresh = await this.opts.getBoostSettings();
    } catch {
      // 修复 L：设置读取失败不再静默 reject（原来 try/catch 之外，抛错无 UI 反馈）。
      this.fail("设置读取失败，请重试或检查扩展存储");
      return;
    }
    this.settings = { ...DEFAULT_SETTINGS, ...fresh };
    this.upstreamCallCount = 0;

    // 新请求递增 requestId：旧请求即使返回也不得覆盖新结果。
    const requestId = randomUUID();
    this.activeRequestId = requestId;
    this.state = "reading";
    this.score = undefined;
    this.scoreStale = false;
    this.detectedStale = false;
    this.lastError = undefined;
    this.session = { requestId, originalText, startedAt: Date.now() };
    this.menuPane = null;
    this.emit();

    await this.runLocalEnhance(this.session);
  }

  /** 发起增强请求（Stage 5 单次调用；Stage 7 支持二次追问）。 */
  private async runLocalEnhance(session: BoostSession, answers?: Record<string, string>): Promise<void> {
    if (this.activeRequestId !== session.requestId) return; // 已被新请求取代。
    this.state = "analyzing";
    this.clarifications = [];
    this.upstreamCallCount += 1;
    this.emit();
    try {
      const settings = await this.opts.getBoostSettings();
      const reply = await sendEnhanceRequest({
        requestId: session.requestId,
        originalText: session.originalText,
        settings: {
          ...settings,
          ...this.settings,
          clarificationAnswers: answers,
        },
      });

      if (this.activeRequestId !== session.requestId) return;
      if (!reply.response) {
        const code = reply.error?.code;
        debugLog("enhanceFailed", {
          requestId: session.requestId,
          enhanceLevel: this.settings.enhanceLevel,
          clarificationMode: this.settings.clarificationMode,
          taskType: this.settings.taskType,
          controllerState: this.state,
          upstreamCallCount: this.upstreamCallCount,
          errorCode: code,
        });
        this.fail(
          code === "not_implemented"
            ? "增强引擎尚未启用（当前为 MVP 骨架阶段）。"
            : mapErrorMessage(code, reply.error?.message),
        );
        return;
      }

      const analysis = reply.response.analysis;
      // Stage 7 Clarification Gate：程序侧判定是否进入 clarifying（不写回输入框）。
      const showClarification = shouldShowClarification(
        this.settings.clarificationMode,
        this.settings.enhanceLevel,
        analysis,
      );
      debugLog("gate", {
        requestId: session.requestId,
        enhanceLevel: this.settings.enhanceLevel,
        clarificationMode: this.settings.clarificationMode,
        clarificationRequired: analysis.clarificationRequired,
        questionCount: analysis.clarificationQuestions.length,
        criticalCount: analysis.criticalMissingInformation?.length ?? 0,
        showClarification,
        hasAnswers: Boolean(answers),
        controllerState: this.state,
        upstreamCallCount: this.upstreamCallCount,
        taskType: this.settings.taskType,
        detectedTaskType: analysis.detectedTaskType,
      });
      if (showClarification && !answers) {
        this.state = "clarifying";
        this.clarifications = analysis.clarificationQuestions.map((q) => ({
          id: q.id,
          question: q.question,
          reason: q.reason ?? "",
          required: q.required ?? false,
        }));
        this.clarificationAnswers = {};
        this.lastBoostResult = {
          originalText: session.originalText,
          enhancedText: reply.response.enhancedText,
          analysis,
          assumptions: reply.response.assumptions ?? [],
          timestamp: Date.now(),
        };
        this.conflictEnhancedText = undefined;
        this.emit();
        return;
      }

      this.commitEnhance(session, reply.response.enhancedText, reply.response.assumptions ?? [], analysis);
    } catch (err) {
      if (this.activeRequestId === session.requestId) {
        // 修复 H：catch 只捕获 getBoostSettings / sendEnhanceRequest 本身的意外异常。
        // sendEnhanceRequest 的失败走 reply.error 分支（上面已单独处理，含真实错误码）；
        // 这里不再硬编码"无法连接本地服务"，避免覆盖校验/INVALID_REQUEST 等真实错误。
        this.fail(mapErrorMessage(undefined, err instanceof Error ? err.message : "增强失败，请重试"));
      }
    }
  }

  /** 把增强结果写回输入框（含冲突保护）。 */
  private commitEnhance(
    session: BoostSession,
    enhancedText: string,
    assumptions: string[],
    analysis: import("@prompt-boost/shared").PromptAnalysis,
  ): void {
    // 并发保护：返回前重新读取输入框；与请求期间不一致则进入 conflict。
    const currentText = this.opts.adapter.readInput();
    if (currentText !== session.originalText) {
      this.state = "conflict";
      this.conflictEnhancedText = enhancedText;
      this.lastBoostResult = {
        originalText: session.originalText,
        enhancedText,
        analysis,
        assumptions,
        timestamp: Date.now(),
      };
      this.emit();
      return;
    }

    this.state = "writing";
    this.emit();
    this.opts.adapter.writeInput(enhancedText);

    this.recordSuccess(session.originalText, enhancedText, assumptions, analysis);
  }

  /** 记录成功（评分、最近结果、detected）。 */
  private recordSuccess(
    originalText: string,
    enhancedText: string,
    assumptions: string[],
    analysis: import("@prompt-boost/shared").PromptAnalysis,
  ): void {
    this.lastBoostResult = { originalText, enhancedText, analysis, assumptions, timestamp: Date.now() };
    this.score = {
      total: analysis.totalScore ?? aggregateScore(analysis.scoreDimensions),
      missing: analysis.missingInformation,
      suggestions: analysis.suggestions,
      dimensions: { ...analysis.scoreDimensions },
      scoreSource: analysis.scoreSource,
      scoredOriginalText: originalText,
    };
    this.scoreStale = false;
    this.detectedTaskType = analysis.detectedTaskType;
    this.detectedStale = false;
    this.state = "success";
    this.conflictEnhancedText = undefined;
    this.emit();
    window.setTimeout(() => {
      if (this.state === "success") {
        this.state = "idle";
        this.emit();
      }
    }, 1800);
  }

  // ── 冲突处理（请求期间用户修改输入） ───────────────────
  /** 取消：保持用户当前输入，不写回。 */
  cancelConflict(): void {
    this.state = "idle";
    this.conflictEnhancedText = undefined;
    this.emit();
  }

  /** 复制增强结果到剪贴板（不覆盖当前输入）。 */
  async copyConflictResult(): Promise<void> {
    const text = this.conflictEnhancedText;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板不可用：回退选中/提示。
      this.lastError = "无法访问剪贴板，请手动复制增强结果";
    }
    this.state = "idle";
    this.conflictEnhancedText = undefined;
    this.emit();
  }

  /** 覆盖当前输入（用户主动确认）。 */
  overwriteWithResult(): void {
    const enhanced = this.conflictEnhancedText;
    if (!enhanced || !this.lastBoostResult) return;
    this.opts.adapter.writeInput(enhanced);
    this.recordSuccess(
      this.lastBoostResult.originalText,
      enhanced,
      this.lastBoostResult.assumptions,
      this.lastBoostResult.analysis,
    );
  }

  // ── Stage 7 追问 ───────────────────────────────────────
  /** 回答追问（持久化答案）。 */
  setClarificationAnswer(id: string, value: string): void {
    this.clarificationAnswers[id] = value;
    this.emit();
  }

  /** 回答并增强：带 answers 二次增强（≤2 次调用）。 */
  async submitClarification(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const answers = { ...this.clarificationAnswers };
    this.state = "analyzing";
    this.emit();
    await this.runLocalEnhance(session, answers);
  }

  /** 使用默认假设：直接用第一轮增强结果，不再调用模型。 */
  useDefaultAssumptions(): void {
    const result = this.lastBoostResult;
    if (!result) return;
    this.commitEnhance(
      { requestId: this.session?.requestId ?? "", originalText: result.originalText, startedAt: result.timestamp },
      result.enhancedText,
      result.assumptions,
      result.analysis,
    );
  }

  /** 撤销：恢复到 originalText（仅最近一次写回）。 */
  undo(): void {
    // 修复 I：conflict 状态下不得覆盖用户新输入——conflict 有明确的操作按钮
    // （取消/复制/覆盖），撤销会静默覆盖用户正在编辑的内容（数据丢失）。
    if (this.state === "conflict") return;
    const result = this.lastBoostResult;
    if (!result) return;
    const text = this.opts.adapter.readInput();
    // 只撤销仍然保持为「最近一次增强结果」的输入框。Toast 出现后用户若已继续
    // 编辑，静默恢复原文会覆盖新内容，因此此时撤销必须成为 no-op。
    if (text !== result.enhancedText) return;
    this.opts.adapter.writeInput(result.originalText);
    this.state = "idle";
    this.emit();
  }

  // ── 二级菜单 ───────────────────────────────────────────
  /** 打开/切换菜单层级。 */
  setMenuPane(pane: MenuPane): void {
    this.menuPane = pane;
    // 打开菜单时刷新过期标记（不调用模型，只比对文本）。
    const text = this.opts.adapter.readInput();
    if (this.score && text !== this.score.scoredOriginalText) {
      this.scoreStale = true;
    }
    if (this.lastBoostResult && text !== this.lastBoostResult.originalText) {
      this.detectedStale = true;
    }
    this.emit();
  }

  /** 切换设置并持久化。 */
  async setSetting<K extends keyof BoostRequestSettings>(field: K, value: BoostRequestSettings[K]): Promise<void> {
    this.settings = { ...this.settings, [field]: value };
    // 手动选择任务类型时清空 detected 展示。
    if (field === "taskType" && value !== "auto") {
      this.detectedStale = true;
    }
    this.emit();
    if (this.opts.saveSettings) {
      await this.opts.saveSettings({ [field]: value } as Partial<BoostRequestSettings>);
    }
  }

  /** 评分入口（离线启发式 /v1/analyze；不调用模型）。 */
  async requestScore(): Promise<void> {
    const composer = this.opts.adapter.findComposer();
    if (!composer) return;
    const text = this.opts.adapter.readInput();
    if (!text.trim()) {
      this.fail("输入内容为空，无法评分");
      return;
    }
    try {
      const settings = await this.opts.getBoostSettings();
      const reply = await sendAnalyzeRequest({
        requestId: randomUUID(),
        text,
        taskType: settings.taskType,
        enhanceLevel: settings.enhanceLevel,
        clarificationMode: settings.clarificationMode,
      });
      if (!reply.result) {
        this.fail(reply.error?.message ?? "评分失败");
        return;
      }
      this.score = {
        total: reply.result.totalScore ?? aggregateScore(reply.result.scoreDimensions),
        missing: reply.result.missingInformation,
        suggestions: reply.result.suggestions,
        dimensions: { ...reply.result.scoreDimensions },
        scoreSource: reply.result.scoreSource === "llm" ? "llm" : "heuristic_fallback",
        scoredOriginalText: text,
      };
      this.scoreStale = false;
      this.emit();
    } catch {
      this.fail("无法获取评分：请检查本地服务");
    }
  }

  /** 关闭浮层/菜单。 */
  dismiss(): void {
    if (this.state === "error") {
      this.state = "idle";
      this.lastError = undefined;
    }
    if (this.state === "conflict") {
      this.state = "idle";
      this.conflictEnhancedText = undefined;
      // 修复 K：conflict 分支同样清空 lastError（原实现 error 分支清、conflict 分支漏清）。
      this.lastError = undefined;
    }
    if (this.state === "clarifying" || this.state === "analyzing") {
      // 关闭追问/分析面板：终止当前会话（含在途请求），晚到的旧响应一律丢弃。
      this.clarifications = [];
      this.clarificationAnswers = {};
      this.session = null;
      this.activeRequestId = null;
      this.state = "idle";
    }
    this.score = undefined;
    this.menuPane = null;
    this.emit();
  }

  private fail(message: string): void {
    this.state = "error";
    this.lastError = message;
    this.emit();
  }
}

/** 统一错误码 → 用户可读文案（不含堆栈 / Key / 内部错误）。 */
export function mapErrorMessage(code: string | undefined, fallback?: string): string {
  switch (code) {
    case "INVALID_REQUEST":
      return "还没有配置可用的 AI Provider：请在设置中添加并启用一个 Provider";
    case "INVALID_API_KEY":
      return "API Key 无效：请在设置中检查后重试";
    case "MODEL_NOT_FOUND":
      return "模型不可用：请在设置中选择一个可用模型";
    case "TIMEOUT":
      return "请求超时，请重试";
    case "timeout":
      // 扩展侧 fetch 超时（区别于 Provider 层 TIMEOUT）——本地服务在跑但生成较慢。
      return "服务生成较慢，请稍候再试";
    case "RATE_LIMITED":
    case "INSUFFICIENT_QUOTA":
      return "请求过于频繁或额度不足，请稍后再试";
    case "RESPONSE_INVALID":
      return "模型返回格式异常，已保留原输入";
    case "PROVIDER_UNAVAILABLE":
      return "AI 服务暂时不可用，请稍后再试";
    case "CONNECTION_FAILED":
    case "network":
      return "无法连接本地服务：请确认 Prompt Boost 本地服务已启动（127.0.0.1:8787）";
    case "validation":
      return "输入内容不符合要求，请检查后重试";
    default:
      return fallback && fallback.length > 0 && fallback.length < 200 ? fallback : "本地服务请求失败";
  }
}
