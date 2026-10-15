/**
 * Pure display helpers for the board. Ported from orcb
 * `session-observer-presentation.ts`; UI strings are Chinese.
 */
import {
  DECLARED_KIND_LABELS,
  NOW_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  isActiveLiveness,
  speechOf,
  type Analysis,
  type AnalysisRunOutcome,
  type AnalysisRunSummary,
  type AnalysisState,
  type AnalysisStatus,
  type BoardColumn,
  type Lifecycle,
  type Liveness,
  type ReviewPhase,
  type ReviewView,
  type SessionView,
} from "./types";

export const COLUMNS: readonly { id: BoardColumn; label: string; hint: string }[] = [
  { id: "unclear", label: "不明确", hint: "尚无足够可靠的当前结论" },
  { id: "waiting_for_user", label: "需要处理", hint: "等待确认、输入、选择或审批" },
  { id: "in_progress", label: "进行中", hint: "Agent 正在推进任务" },
  { id: "completed", label: "已完成", hint: "当前分析明确表示任务完成" },
  { id: "deferred", label: "延迟队列", hint: "暂缓显示，到期自动恢复" },
  { id: "closed", label: "已关闭", hint: "Agent 会话已经结束或归档" },
];

/** Fixed defer durations offered by the card button and the detail pane. */
export const DEFER_DURATIONS: readonly { ms: number; label: string }[] = [
  { ms: 60_000, label: "1 分钟" },
  { ms: 30 * 60_000, label: "30 分钟" },
  { ms: 60 * 60_000, label: "1 小时" },
  { ms: 4 * 60 * 60_000, label: "4 小时" },
  { ms: 8 * 60 * 60_000, label: "8 小时" },
  { ms: 24 * 60 * 60_000, label: "24 小时" },
  { ms: 2 * 24 * 60 * 60_000, label: "2 天" },
  { ms: 4 * 24 * 60 * 60_000, label: "4 天" },
];

const DAY_NAMES = ["今天", "明天", "后天"];

/** Absolute defer targets: day offset from today plus an hour of the day. */
export const DEFER_CLOCK_TARGETS: readonly { dayOffset: number; hour: number }[] = [
  { dayOffset: 0, hour: 14 },
  { dayOffset: 0, hour: 18 },
  { dayOffset: 1, hour: 9 },
  { dayOffset: 1, hour: 14 },
  { dayOffset: 1, hour: 18 },
  { dayOffset: 2, hour: 9 },
  { dayOffset: 2, hour: 14 },
  { dayOffset: 2, hour: 18 },
];

export function deferClockLabel(target: { dayOffset: number; hour: number }): string {
  return `至${DAY_NAMES[target.dayOffset]} ${target.hour}:00`;
}

/** Timestamp of the target's local wall-clock time, relative to `now`. */
export function deferClockTimestamp(
  target: { dayOffset: number; hour: number },
  now: number,
): number {
  const date = new Date(now);
  date.setDate(date.getDate() + target.dayOffset);
  date.setHours(target.hour, 0, 0, 0);
  return date.getTime();
}

export const STATUS_OPTIONS: readonly { status: AnalysisStatus; label: string }[] = [
  { status: "waiting_for_user", label: "需要处理" },
  { status: "blocked", label: "阻塞" },
  { status: "in_progress", label: "进行中" },
  { status: "completed", label: "已完成" },
  { status: "unclear", label: "不明确" },
];

/** blocked belongs to the needs-action column. */
export function columnForStatus(status: AnalysisStatus): BoardColumn {
  if (status === "waiting_for_user" || status === "blocked") {
    return "waiting_for_user";
  }
  return status;
}

export function firstLine(value: string | null | undefined, maxLength = 96): string | null {
  if (!value) {
    return null;
  }
  const line = value.replace(/\s+/g, " ").trim();
  if (!line) {
    return null;
  }
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}…` : line;
}

export function sessionTitle(session: SessionView): string {
  return (
    firstLine(session.analysis?.title, TITLE_MAX_LENGTH) ??
    firstLine(session.agentTitle) ??
    firstLine(session.lastUserInput) ??
    `${session.provider} 会话`
  );
}

function lastSegments(path: string, count: number): string {
  const parts = path
    .normalize("NFC")
    .replace(/\\/g, "/")
    .split("/")
    .filter(function nonEmpty(part) {
      return part.length > 0;
    });
  return parts.slice(-count).join("/");
}

export function workspaceLabel(session: SessionView): string {
  const name = session.workspaceName?.trim();
  if (name) {
    return name;
  }
  const fromCwd = session.cwd ? lastSegments(session.cwd, 2) : "";
  return fromCwd || "未知";
}

export function branchLabel(session: SessionView): string | null {
  const branch = session.branch?.trim();
  if (!branch) {
    return null;
  }
  return branch.replace(/^refs\/heads\//, "");
}

export function analysisStateLabel(state: AnalysisState): string {
  switch (state) {
    case "awaiting_output":
      return "等待有效回复";
    case "queued":
      return "等待分析";
    case "running":
      return "正在分析";
    case "ready":
      return "分析已就绪";
    case "failed":
      return "分析失败";
  }
}

export function analysisStatusLabel(status: AnalysisStatus): string {
  const match = STATUS_OPTIONS.find(function byStatus(option) {
    return option.status === status;
  });
  return match ? match.label : "不明确";
}

export function lifecycleLabel(lifecycle: Lifecycle): string {
  switch (lifecycle) {
    case "working":
      return "运行中";
    case "waiting_permission":
      return "等待授权";
    case "idle":
      return "空闲";
    case "error":
      return "出错";
    case "unknown":
      return "未知";
  }
}

export function livenessLabel(liveness: Liveness): string {
  switch (liveness) {
    case "live":
      return "活跃";
    case "dormant":
      return "未连接";
    case "closed":
      return "已关闭";
    case "archived":
      return "已归档";
  }
}

/** Shown when a Paseo restart closed the session while it had work in flight. */
export const RESTART_INTERRUPTED_TEXT = "Paseo 重启时任务被中断";

/** Live agent state read from the open conversation; fresher than the session snapshot. */
export type LiveState = {
  running: boolean;
  pendingPermissions: number;
  userText: string | null;
  activity: string | null;
};

export type NowTone = "working" | "waiting" | "blocked" | "done" | "idle";

/** Badge text for the review phase; verdict counts show once the verify reply lands. */
export function reviewBadgeLabel(review: ReviewView): string {
  switch (review.phase) {
    case "suggested":
      return "建议代码审查";
    case "requested":
      return "已请求审查";
    case "reviewing":
      return "审查中";
    case "verifying":
      return "复核中";
    case "awaiting_confirmation": {
      const verdict = review.verdict;
      return verdict
        ? `待确认审查结果（成立 ${verdict.valid} / 不成立 ${verdict.invalid} / 存疑 ${verdict.unsure}）`
        : "待确认审查结果";
    }
    case "failed":
      return "审查未启动";
    case "interrupted":
      return "审查被中断";
  }
}

/** Badge tone for the review phase. */
export function reviewBadgeTone(phase: ReviewPhase): "accent" | "warning" | "danger" | "muted" {
  switch (phase) {
    case "suggested":
    case "requested":
    case "reviewing":
    case "verifying":
      return "accent";
    case "awaiting_confirmation":
    case "failed":
      return "warning";
    case "interrupted":
      return "danger";
  }
}

/** The 现在 line of the detail pane. */
export type NowLine = { tone: NowTone; text: string; detail: string | null };

function toneForStatus(status: AnalysisStatus): NowTone {
  switch (status) {
    case "in_progress":
      return "working";
    case "waiting_for_user":
      return "waiting";
    case "blocked":
      return "blocked";
    case "completed":
      return "done";
    case "unclear":
      return "idle";
  }
}

/**
 * What the session is doing right now. Live state wins over the analysis,
 * which only describes the last finished turn.
 */
export function nowLine(session: SessionView, live: LiveState | null): NowLine {
  const analysis = session.analysis;
  // Older analyses have no `now`; their speech may fall back to the long summary.
  const said = analysis ? (firstLine(analysis.now) ?? firstLine(speechOf(analysis), 120)) : null;
  if (!isActiveLiveness(session.liveness)) {
    return { tone: "idle", text: "会话已关闭", detail: said };
  }
  if (session.liveness === "dormant") {
    return {
      tone: "waiting",
      text: session.interruptedAt !== null ? RESTART_INTERRUPTED_TEXT : "Paseo 重启后未连接",
      detail: "恢复后可继续",
    };
  }
  const pending = live ? live.pendingPermissions : session.pendingPermissionCount;
  if (pending > 0) {
    return {
      tone: "waiting",
      text: pending > 1 ? `等你授权（${pending} 个请求）` : "等你授权",
      detail: "在右侧会话里批准或拒绝",
    };
  }
  if (live ? live.running : session.lifecycle === "working") {
    const ask = firstLine(live?.userText, NOW_MAX_LENGTH);
    return {
      tone: "working",
      text: ask ? `正在处理：${ask}` : "正在运行",
      detail: live?.activity ? firstLine(live.activity, NOW_MAX_LENGTH) : null,
    };
  }
  // Idle with a review underway: the phase says more than the last analysis.
  const review = session.review;
  if (review !== null) {
    const reviewTone: NowTone =
      review.phase === "failed" || review.phase === "interrupted"
        ? "blocked"
        : review.phase === "awaiting_confirmation"
          ? "waiting"
          : review.phase === "suggested"
            ? "idle"
            : "working";
    return { tone: reviewTone, text: reviewBadgeLabel(review), detail: review.reason };
  }
  if (session.lifecycle === "error") {
    return { tone: "blocked", text: "Agent 出错", detail: said };
  }
  const tone = toneForStatus(session.effectiveStatus);
  const updating = session.analysisState === "queued" || session.analysisState === "running";
  if (!analysis) {
    const declared = session.declared;
    return {
      tone,
      text: declared
        ? `${DECLARED_KIND_LABELS[declared.kind]}：${declared.text}`
        : `${analysisStateLabel(session.analysisState)}，暂无分析结论`,
      detail: null,
    };
  }
  const blocker = tone === "blocked" ? firstLine(analysis.blockers[0], 80) : null;
  return {
    tone,
    text: said ?? "暂无",
    detail: blocker ? `卡在：${blocker}` : updating ? "分析更新中…" : null,
  };
}

/** Badge text for resume/reopen progress; idle closed sessions show nothing. */
export function resumeStateLabel(
  session: Pick<SessionView, "liveness" | "resumeState">,
): string | null {
  if (session.liveness === "closed" || session.liveness === "archived") {
    switch (session.resumeState) {
      case "queued":
      case "resuming":
        return "重新打开中…";
      case "failed":
        return "重新打开失败";
      default:
        return null;
    }
  }
  if (session.liveness !== "dormant") {
    return null;
  }
  switch (session.resumeState) {
    case "queued":
    case "resuming":
      return "恢复中…";
    case "failed":
      return "恢复失败";
    default:
      return "未连接";
  }
}

/** Time of a 之前 item: HH:mm today, MM-DD HH:mm otherwise. */
export function formatStepTime(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const pad = (value: number) => String(value).padStart(2, "0");
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? clock : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

/** Compact Chinese age label: 刚刚 / N分钟前 / N小时前 / N天前. */
export function formatShortTimeAgo(timestamp: number, now: number): string {
  const delta = now - timestamp;
  if (delta < 60_000) {
    return "刚刚";
  }
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) {
    return `${minutes}分钟前`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}小时前`;
  }
  return `${Math.floor(hours / 24)}天前`;
}

/** Resume time for a deferred session: today shows HH:mm, later dates add M月d日. */
export function formatDeferUntil(until: number, now: number): string {
  const date = new Date(until);
  const pad = (value: number) => String(value).padStart(2, "0");
  const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay ? hm : `${date.getMonth() + 1}月${date.getDate()}日 ${hm}`;
}

/** Compact Chinese countdown: 即将恢复 / 剩余 N 分钟 / N 小时 / N 天. */
export function formatDeferRemaining(until: number, now: number): string {
  const delta = until - now;
  if (delta <= 0) {
    return "即将恢复";
  }
  const minutes = Math.ceil(delta / 60_000);
  if (minutes < 60) {
    return `剩余 ${minutes} 分钟`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) {
    return `剩余 ${hours} 小时`;
  }
  return `剩余 ${Math.ceil(hours / 24)} 天`;
}

const RUN_OUTCOME_LABELS: Record<AnalysisRunOutcome, string> = {
  applied: "已采用",
  failed: "失败",
  superseded: "未采用：已有更新的轮次",
  discarded: "未采用：会话已归档",
};

export function analysisRunOutcomeLabel(outcome: AnalysisRunOutcome): string {
  return RUN_OUTCOME_LABELS[outcome];
}

export function confidenceLabel(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/** Analyzer call duration: 0.8 秒 / 42 秒 / 2 分 5 秒. */
export function formatDuration(ms: number): string {
  if (ms < 10_000) {
    return `${(Math.max(0, ms) / 1000).toFixed(1)} 秒`;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  const rest = seconds % 60;
  return rest === 0 ? `${Math.floor(seconds / 60)} 分` : `${Math.floor(seconds / 60)} 分 ${rest} 秒`;
}

/**
 * The 分析记录 header note: the newest call's confidence, or that it failed.
 * Sessions analyzed before calls were logged fall back to the stored analysis.
 */
export function latestRunNote(
  runs: readonly Pick<AnalysisRunSummary, "confidence">[],
  analysis: Pick<Analysis, "confidence"> | null,
): string | null {
  const latest = runs[0];
  if (latest) {
    return latest.confidence === null ? "最近一次失败" : `置信度 ${confidenceLabel(latest.confidence)}`;
  }
  return analysis ? `置信度 ${confidenceLabel(analysis.confidence)}` : null;
}
