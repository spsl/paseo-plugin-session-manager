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
  { id: "closed", label: "已关闭", hint: "Agent 会话已经结束或归档" },
];

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
    case "closed":
      return "已关闭";
    case "archived":
      return "已归档";
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
