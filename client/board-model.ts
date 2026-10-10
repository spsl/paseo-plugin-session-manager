/** Pure board logic: grouping, polling cadence and optimistic snapshot patches. */
import { columnForStatus } from "../shared/presentation";
import {
  BOARD_COLUMNS,
  type AnalysisStatus,
  type BoardColumn,
  type SessionView,
} from "../shared/types";

export const POLL_BUSY_MS = 2_500;
export const POLL_IDLE_MS = 10_000;

type WithSessions = { sessions: SessionView[]; seeding?: boolean };

/** Groups sessions per column, most recently updated first. */
export function groupByColumn(
  sessions: readonly SessionView[],
): Record<BoardColumn, SessionView[]> {
  const groups = {} as Record<BoardColumn, SessionView[]>;
  for (const column of BOARD_COLUMNS) {
    groups[column] = [];
  }
  for (const session of sessions) {
    groups[session.column].push(session);
  }
  for (const column of BOARD_COLUMNS) {
    groups[column].sort(function byUpdatedDesc(left, right) {
      return right.updatedAt - left.updatedAt;
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

export function pollIntervalFor(snapshot: WithSessions | undefined): number {
  if (!snapshot) {
    return POLL_IDLE_MS;
  }
  if (snapshot.seeding) {
    return POLL_BUSY_MS;
  }
  const busy = snapshot.sessions.some(function isBusy(session) {
    return session.analysisState === "queued" || session.analysisState === "running";
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
  const column: BoardColumn = session.liveness === "live" ? columnForStatus(status) : "closed";
  return {
    ...session,
    effectiveStatus: status,
    column,
    needsAttention:
      session.liveness === "live" &&
      (column === "waiting_for_user" || session.pendingPermissionCount > 0),
  };
}

export function patchManualStatus<T extends WithSessions>(
  snapshot: T,
  sessionId: string,
  status: AnalysisStatus,
): T {
  return mapSession(snapshot, sessionId, function apply(session) {
    if (session.liveness !== "live") {
      return session;
    }
    return { ...withStatus(session, status), manualStatusOverride: status };
  });
}

/** Mirrors the server projection: permission > working > model verdict. */
export function automaticStatus(session: SessionView): AnalysisStatus {
  if (session.pendingPermissionCount > 0) {
    return "waiting_for_user";
  }
  if (session.lifecycle === "working") {
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
  const clamped = Math.min(100, Math.max(1, percent));
  return Math.max(MIN_COLUMN_WIDTH, Math.floor((fill * clamped) / 100));
}
