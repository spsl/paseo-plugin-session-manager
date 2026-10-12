/** Pure board logic: grouping, polling cadence and optimistic snapshot patches. */
import { columnForStatus } from "../shared/presentation";
import {
  BOARD_COLUMNS,
  isActiveLiveness,
  type AnalysisStatus,
  type BoardColumn,
  type SessionView,
} from "../shared/types";

export const POLL_BUSY_MS = 2_500;
export const POLL_IDLE_MS = 10_000;

type WithSessions = { sessions: SessionView[]; seeding?: boolean };

/** An active (live or dormant) session whose defer time is still in the future. */
export function isDeferred(session: SessionView, now: number): boolean {
  return (
    isActiveLiveness(session.liveness) &&
    session.deferredUntil !== null &&
    session.deferredUntil > now
  );
}

/**
 * The column a card renders in at `now`. Queued defers park in "deferred";
 * everything else follows the server projection, except a stale "deferred"
 * projection whose defer already expired locally (it rejoins its real column
 * without waiting for the next snapshot).
 */
export function boardColumnOf(session: SessionView, now: number): BoardColumn {
  if (isDeferred(session, now) && session.deferToQueue) {
    return "deferred";
  }
  if (session.column === "deferred") {
    return isActiveLiveness(session.liveness) ? columnForStatus(session.effectiveStatus) : "closed";
  }
  return session.column;
}

/**
 * Groups sessions per column at `now`. Normal columns put deferred cards last;
 * the deferred column itself orders by resume time, soonest first.
 */
export function groupByColumn(
  sessions: readonly SessionView[],
  now: number,
): Record<BoardColumn, SessionView[]> {
  const groups = {} as Record<BoardColumn, SessionView[]>;
  for (const column of BOARD_COLUMNS) {
    groups[column] = [];
  }
  for (const session of sessions) {
    groups[boardColumnOf(session, now)].push(session);
  }
  for (const column of BOARD_COLUMNS) {
    if (column === "deferred") {
      groups[column].sort(function byResumeAsc(left, right) {
        return (left.deferredUntil ?? 0) - (right.deferredUntil ?? 0);
      });
      continue;
    }
    groups[column].sort(function byDeferredLast(left, right) {
      const deferredDiff = Number(isDeferred(left, now)) - Number(isDeferred(right, now));
      return deferredDiff !== 0 ? deferredDiff : right.updatedAt - left.updatedAt;
    });
  }
  return groups;
}

export function attentionSessions(
  sessions: readonly SessionView[],
  limit: number,
): SessionView[] {
  return sessions
    .filter(function needs(session) {
      return session.needsAttention;
    })
    .sort(function byUpdatedDesc(left, right) {
      return right.updatedAt - left.updatedAt;
    })
    .slice(0, limit);
}

/**
 * The workspace group a session belongs to: the Paseo workspace when known,
 * else its project, else the working directory (last path segment as label).
 */
export function workspaceKeyOf(session: SessionView): string {
  const workspaceId = session.workspaceId?.trim();
  if (workspaceId) {
    return `ws:${workspaceId}`;
  }
  const projectKey = session.projectKey?.trim();
  if (projectKey) {
    return `proj:${projectKey}`;
  }
  return `cwd:${session.cwd}`;
}

export function workspaceLabelOf(session: SessionView): string {
  const name = session.workspaceName?.trim() || session.projectName?.trim();
  if (name) {
    return name;
  }
  const parts = session.cwd.split("/").filter(function nonEmpty(part) {
    return part !== "";
  });
  return parts.length > 0 ? (parts[parts.length - 1] ?? "未关联") : "未关联";
}

export type WorkspaceAttentionGroup = {
  key: string;
  label: string;
  attentionCount: number;
};

/** Workspaces that have sessions needing attention, most urgent first. */
export function workspaceAttentionGroups(
  sessions: readonly SessionView[],
): WorkspaceAttentionGroup[] {
  const groups = new Map<string, WorkspaceAttentionGroup & { latest: number }>();
  for (const session of sessions) {
    if (!session.needsAttention) {
      continue;
    }
    const key = workspaceKeyOf(session);
    const current = groups.get(key);
    if (current) {
      current.attentionCount += 1;
      current.latest = Math.max(current.latest, session.updatedAt);
    } else {
      groups.set(key, {
        key,
        label: workspaceLabelOf(session),
        attentionCount: 1,
        latest: session.updatedAt,
      });
    }
  }
  return [...groups.values()]
    .sort(function byRecent(left, right) {
      return right.latest - left.latest || left.label.localeCompare(right.label, "zh-CN");
    })
    .map(function strip(group) {
      return { key: group.key, label: group.label, attentionCount: group.attentionCount };
    });
}

export function pollIntervalFor(snapshot: WithSessions | undefined): number {
  if (!snapshot) {
    return POLL_IDLE_MS;
  }
  if (snapshot.seeding) {
    return POLL_BUSY_MS;
  }
  const busy = snapshot.sessions.some(function isBusy(session) {
    return (
      session.analysisState === "queued" ||
      session.analysisState === "running" ||
      session.resumeState === "queued" ||
      session.resumeState === "resuming"
    );
  });
  return busy ? POLL_BUSY_MS : POLL_IDLE_MS;
}

function mapSession<T extends WithSessions>(
  snapshot: T,
  sessionId: string,
  patch: (session: SessionView) => SessionView,
): T {
  return {
    ...snapshot,
    sessions: snapshot.sessions.map(function apply(session) {
      return session.id === sessionId ? patch(session) : session;
    }),
  };
}

function withStatus(session: SessionView, status: AnalysisStatus): SessionView {
  const column: BoardColumn = isActiveLiveness(session.liveness)
    ? columnForStatus(status)
    : "closed";
  return {
    ...session,
    effectiveStatus: status,
    column,
    needsAttention:
      isActiveLiveness(session.liveness) &&
      (column === "waiting_for_user" || session.pendingPermissionCount > 0),
  };
}

export function patchManualStatus<T extends WithSessions>(
  snapshot: T,
  sessionId: string,
  status: AnalysisStatus,
): T {
  return mapSession(snapshot, sessionId, function apply(session) {
    if (!isActiveLiveness(session.liveness)) {
      return session;
    }
    return { ...withStatus(session, status), manualStatusOverride: status };
  });
}

/** Mirrors the server projection: interrupted > permission > working > model verdict. */
export function automaticStatus(session: SessionView): AnalysisStatus {
  if (session.interruptedAt !== null) {
    return "waiting_for_user";
  }
  const live = session.liveness === "live";
  if (live && session.pendingPermissionCount > 0) {
    return "waiting_for_user";
  }
  if (live && session.lifecycle === "working") {
    return "in_progress";
  }
  return session.modelStatus;
}

export function patchClearManualStatus<T extends WithSessions>(snapshot: T, sessionId: string): T {
  return mapSession(snapshot, sessionId, function apply(session) {
    return {
      ...withStatus(session, automaticStatus(session)),
      manualStatusOverride: null,
    };
  });
}

export function patchReanalyze<T extends WithSessions>(snapshot: T, sessionId: string): T {
  return mapSession(snapshot, sessionId, function apply(session) {
    return { ...session, analysisState: "queued", analysisError: null };
  });
}

export function patchDefer<T extends WithSessions>(
  snapshot: T,
  sessionId: string,
  until: number,
  toQueue: boolean,
): T {
  return mapSession(snapshot, sessionId, function apply(session) {
    if (!isActiveLiveness(session.liveness)) {
      return session;
    }
    const column: BoardColumn = toQueue
      ? "deferred"
      : session.column === "deferred"
        ? columnForStatus(session.effectiveStatus)
        : session.column;
    return {
      ...session,
      deferredUntil: until,
      deferToQueue: toQueue,
      column,
      needsAttention: false,
    };
  });
}

export function patchClearDefer<T extends WithSessions>(snapshot: T, sessionId: string): T {
  return mapSession(snapshot, sessionId, function apply(session) {
    const column =
      session.column === "deferred"
        ? isActiveLiveness(session.liveness)
          ? columnForStatus(session.effectiveStatus)
          : "closed"
        : session.column;
    return {
      ...session,
      deferredUntil: null,
      deferToQueue: false,
      column,
      needsAttention:
        isActiveLiveness(session.liveness) &&
        (column === "waiting_for_user" || session.pendingPermissionCount > 0),
    };
  });
}

/** Optimistic: a resume request was accepted; the board shows "恢复中…". */
export function patchResume<T extends WithSessions>(snapshot: T, sessionId: string): T {
  return mapSession(snapshot, sessionId, function apply(session) {
    if (session.liveness !== "dormant") {
      return session;
    }
    return { ...session, resumeState: "resuming", resumeError: null };
  });
}

/** Optimistic: "不再恢复" drops the session into the closed column. */
export function patchDismissResume<T extends WithSessions>(snapshot: T, sessionId: string): T {
  return mapSession(snapshot, sessionId, function apply(session) {
    if (session.liveness !== "dormant") {
      return session;
    }
    return {
      ...session,
      liveness: "closed",
      interruptedAt: null,
      resumeState: "idle",
      resumeError: null,
      deferredUntil: null,
      deferToQueue: false,
      column: "closed",
      needsAttention: false,
    };
  });
}

export function patchForget<T extends WithSessions>(snapshot: T, sessionId: string): T {
  return {
    ...snapshot,
    sessions: snapshot.sessions.filter(function keep(session) {
      return session.id !== sessionId;
    }),
  };
}

/** Wide-board geometry: horizontal padding and gap between the five columns. */
export const BOARD_PADDING = 12;
export const BOARD_GAP = 12;
export const MIN_COLUMN_WIDTH = 200;

/**
 * Width of one column: `percent` of the width that would make all columns fill
 * `containerWidth`, never below MIN_COLUMN_WIDTH. null until the container is measured.
 */
export function columnWidthFor(
  containerWidth: number,
  percent: number,
  columnCount: number,
): number | null {
  if (!(containerWidth > 0) || columnCount < 1) {
    return null;
  }
  const fill = (containerWidth - BOARD_PADDING * 2 - BOARD_GAP * (columnCount - 1)) / columnCount;
  const clamped = Math.min(500, Math.max(1, percent));
  return Math.max(MIN_COLUMN_WIDTH, Math.floor((fill * clamped) / 100));
}
