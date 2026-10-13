/**
 * Pure display helpers for the board. Ported from orcb
 * `session-observer-presentation.ts`; UI strings are Chinese.
 */
import {
  TITLE_MAX_LENGTH,
  type AnalysisState,
  type AnalysisStatus,
  type BoardColumn,
  type Lifecycle,
  type Liveness,
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

/** Badge text for a dormant session's resume progress; null for other liveness. */
export function resumeStateLabel(
  session: Pick<SessionView, "liveness" | "resumeState">,
): string | null {
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
