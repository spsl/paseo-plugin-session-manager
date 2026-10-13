/** Pure board logic: grouping, polling cadence and optimistic snapshot patches. */
import { columnForStatus } from "../shared/presentation";
import { filterSessionsByProject } from "../shared/project-filter";
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

/** A card as rendered on the board: a session plus its embedded sub-agents. */
export type BoardCard = {
  session: SessionView;
  /** Sub-agents flattened into this card, newest activity first. */
  children: readonly SessionView[];
  /**
   * Set on a sub-agent that renders as its own card because its parent is
   * missing from the snapshot, closed, or filtered out; feeds the "父：" link.
   */
  detachedParent: SessionView | null;
};

export type BoardLayout = {
  groups: Record<BoardColumn, BoardCard[]>;
  /** Embedded sub-agent id -> the card id hosting it (for auto-expand/highlight). */
  hostByChildId: ReadonlyMap<string, string>;
};

/** A session that can host sub-agents: visible on the board and not closed. */
function isCardHost(
  session: SessionView,
  visibleIds: ReadonlySet<string>,
  now: number,
): boolean {
  return visibleIds.has(session.id) && boardColumnOf(session, now) !== "closed";
}

function byUpdatedAtDesc(left: SessionView, right: SessionView): number {
  return right.updatedAt - left.updatedAt;
}

/** Shared empty row list so childless cards keep a stable prop reference. */
export const EMPTY_SUBAGENTS: readonly SessionView[] = [];

/**
 * The direct parent shown as the "父：" link on a standalone sub-agent card;
 * null when the parent is absent from the snapshot or the id self-references.
 */
function detachedParentOf(
  session: SessionView,
  universeById: ReadonlyMap<string, SessionView>,
): SessionView | null {
  const parentId = session.parentAgentId;
  if (parentId === null || parentId === session.id) {
    return null;
  }
  return universeById.get(parentId) ?? null;
}

/**
 * The topmost visible non-closed ancestor of `session`. The parentAgentId
 * chain is climbed through filtered-out or closed ancestors; stops at a
 * missing parent or the first repeated id (cycle defense).
 */
function topmostHostId(
  session: SessionView,
  universeById: ReadonlyMap<string, SessionView>,
  visibleIds: ReadonlySet<string>,
  now: number,
): string | null {
  let host: string | null = null;
  const seen = new Set<string>();
  seen.add(session.id);
  let current = session;
  while (current.parentAgentId !== null) {
    const parent = universeById.get(current.parentAgentId);
    if (parent === undefined || seen.has(parent.id)) {
      break;
    }
    seen.add(parent.id);
    if (isCardHost(parent, visibleIds, now)) {
      host = parent.id;
    }
    current = parent;
  }
  return host;
}

/**
 * Board layout with sub-agents embedded into their topmost visible
 * non-closed ancestor's card; multi-level nesting flattens onto that card.
 * A sub-agent renders as its own card (with `detachedParent` for the "父："
 * link) only when no such ancestor exists. Cyclic ancestry never hangs and
 * never drops a session: hosts that resolve into each other render standalone.
 */
export function groupBoardCards(
  visible: readonly SessionView[],
  universe: readonly SessionView[],
  now: number,
): BoardLayout {
  const universeById = new Map<string, SessionView>();
  for (const session of universe) {
    universeById.set(session.id, session);
  }
  const visibleIds = new Set<string>();
  const visibleById = new Map<string, SessionView>();
  for (const session of visible) {
    visibleIds.add(session.id);
    visibleById.set(session.id, session);
  }

  const cardById = new Map<string, BoardCard>();
  const embedded = new Map<string, string>();
  for (const session of visible) {
    const hostId =
      session.parentAgentId === null
        ? null
        : topmostHostId(session, universeById, visibleIds, now);
    if (hostId === null) {
      cardById.set(session.id, {
        session,
        children: EMPTY_SUBAGENTS,
        detachedParent: detachedParentOf(session, universeById),
      });
    } else {
      embedded.set(session.id, hostId);
    }
  }

  const hostByChildId = new Map<string, string>();
  const childrenByHost = new Map<string, SessionView[]>();
  for (const [childId, initialHost] of embedded) {
    const child = visibleById.get(childId);
    if (child === undefined) {
      continue;
    }
    // The topmost host is a card unless the ancestry cycles; chase the host
    // chain to detect that and promote the child to a standalone card.
    let host: string | null = initialHost;
    const seen = new Set<string>([childId]);
    while (host !== null && embedded.has(host)) {
      if (seen.has(host)) {
        host = null;
        break;
      }
      seen.add(host);
      host = embedded.get(host) ?? null;
    }
    const card = host === null ? undefined : cardById.get(host);
    if (host !== null && card !== undefined) {
      hostByChildId.set(childId, host);
      const siblings = childrenByHost.get(host);
      if (siblings === undefined) {
        childrenByHost.set(host, [child]);
      } else {
        siblings.push(child);
      }
    } else {
      cardById.set(child.id, {
        session: child,
        children: EMPTY_SUBAGENTS,
        detachedParent: detachedParentOf(child, universeById),
      });
    }
  }

  for (const [host, siblings] of childrenByHost) {
    siblings.sort(byUpdatedAtDesc);
    const card = cardById.get(host);
    if (card !== undefined) {
      card.children = siblings;
    }
  }

  const cardSessions: SessionView[] = [];
  for (const card of cardById.values()) {
    cardSessions.push(card.session);
  }
  const sessionGroups = groupByColumn(cardSessions, now);
  const groups = {} as Record<BoardColumn, BoardCard[]>;
  for (const column of BOARD_COLUMNS) {
    const cards: BoardCard[] = [];
    for (const session of sessionGroups[column]) {
      const card = cardById.get(session.id);
      if (card !== undefined) {
        cards.push(card);
      }
    }
    groups[column] = cards;
  }
  return { groups, hostByChildId };
}

/** Sessions that render their own card, in column order (embedded children excluded). */
export function cardSessions(layout: BoardLayout): SessionView[] {
  const sessions: SessionView[] = [];
  for (const column of BOARD_COLUMNS) {
    for (const card of layout.groups[column]) {
      sessions.push(card.session);
    }
  }
  return sessions;
}

/**
 * Cards whose sub-agent section renders expanded: manually toggled cards plus
 * the host of a hit sub-agent (a deep link via sessionId), so the row stays
 * visible. Used to auto-expand a parent when a hit lands on an embedded child.
 */
export function expandedCardIds(
  toggled: ReadonlySet<string>,
  focusChildId: string | null,
  hostByChildId: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  if (focusChildId === null) {
    return toggled;
  }
  const host = hostByChildId.get(focusChildId);
  if (host === undefined) {
    return toggled;
  }
  const next = new Set(toggled);
  next.add(host);
  return next;
}

/** Expansion state for a board: manual toggles plus the live deep-link hit. */
export type ExpansionState = {
  /** The manual toggle set. */
  toggled: ReadonlySet<string>;
  /** The hit child id; cleared when collapsing the card hosting it. */
  hitChildId: string | null;
};

/**
 * Toggles a card's sub-agent section by what is currently displayed: a card
 * shown expanded collapses (also dropping a hit that lands inside, since the
 * hit alone kept it open); a shown-collapsed card expands.
 */
export function toggleCardExpansion(
  displayed: ReadonlySet<string>,
  toggled: ReadonlySet<string>,
  hitChildId: string | null,
  hostByChildId: ReadonlyMap<string, string>,
  cardId: string,
): ExpansionState {
  if (displayed.has(cardId)) {
    const next = new Set(toggled);
    next.delete(cardId);
    const clearsHit = hitChildId !== null && hostByChildId.get(hitChildId) === cardId;
    return { toggled: next, hitChildId: clearsHit ? null : hitChildId };
  }
  const next = new Set(toggled);
  next.add(cardId);
  return { toggled: next, hitChildId };
}

export type ExpansionAction =
  | { type: "toggle"; cardId: string; hostByChildId: ReadonlyMap<string, string> }
  | { type: "hit"; childId: string | null };

/** useReducer companion so callers keep a stable dispatch reference. */
export function reduceExpansion(state: ExpansionState, action: ExpansionAction): ExpansionState {
  if (action.type === "hit") {
    return { toggled: state.toggled, hitChildId: action.childId };
  }
  const displayed = expandedCardIds(state.toggled, state.hitChildId, action.hostByChildId);
  return toggleCardExpansion(displayed, state.toggled, state.hitChildId, action.hostByChildId, action.cardId);
}

export type SubagentStatus = {
  /** The board column whose tone the status dot and label follow. */
  column: BoardColumn;
  label: string;
  /** Counted in the 需处理 aggregate (waiting, blocked or 待授权). */
  attention: boolean;
};

/** Status of an embedded sub-agent row, following the same column semantics as the board. */
export function subagentStatusOf(session: SessionView, now: number): SubagentStatus {
  if (!isActiveLiveness(session.liveness)) {
    return { column: "closed", label: "已关闭", attention: false };
  }
  // Deferred children (masked or queued) park as 已延迟, matching the server's
  // needsAttention = active && !deferred.
  if (isDeferred(session, now)) {
    return { column: "deferred", label: "已延迟", attention: false };
  }
  const column = boardColumnOf(session, now);
  if (column === "waiting_for_user" || session.pendingPermissionCount > 0) {
    return { column: "waiting_for_user", label: "需处理", attention: true };
  }
  switch (column) {
    case "in_progress":
      return { column, label: "进行中", attention: false };
    case "completed":
      return { column, label: "已完成", attention: false };
    default:
      return { column: "unclear", label: "未明确", attention: false };
  }
}

export type SubagentCounts = {
  total: number;
  /** 需处理 (warning tone). */
  attention: number;
  /** 进行中 (accent tone). */
  inProgress: number;
  /** 已完成 (success tone). */
  completed: number;
  /** 未明确 (muted tone). */
  unclear: number;
  /** 已延迟 (muted tone). */
  deferred: number;
  /** 已关闭 (muted tone). */
  closed: number;
};

/** Collapsed-header aggregates for a card's embedded sub-agents. */
export function countSubagents(children: readonly SessionView[], now: number): SubagentCounts {
  const counts: SubagentCounts = {
    total: children.length,
    attention: 0,
    inProgress: 0,
    completed: 0,
    unclear: 0,
    deferred: 0,
    closed: 0,
  };
  for (const child of children) {
    const status = subagentStatusOf(child, now);
    if (status.attention) {
      counts.attention += 1;
      continue;
    }
    switch (status.column) {
      case "in_progress":
        counts.inProgress += 1;
        break;
      case "completed":
        counts.completed += 1;
        break;
      case "deferred":
        counts.deferred += 1;
        break;
      case "closed":
        counts.closed += 1;
        break;
      default:
        counts.unclear += 1;
    }
  }
  return counts;
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

/** Cards outside the closed column — the counting unit for board numbers. */
export function openCardCount(layout: BoardLayout): number {
  let count = 0;
  for (const column of BOARD_COLUMNS) {
    if (column !== "closed") {
      count += layout.groups[column].length;
    }
  }
  return count;
}

/**
 * Open-card count per project key, each computed from that project's own
 * view: a sub-agent whose parent sits in another project renders standalone
 * there and counts toward its own project.
 */
export function projectCardCounts(
  allSessions: readonly SessionView[],
  projectKeyBySessionId: ReadonlyMap<string, string>,
  projectKeys: readonly string[],
  now: number,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const key of projectKeys) {
    const visible = filterSessionsByProject(allSessions, projectKeyBySessionId, new Set([key]));
    counts.set(key, openCardCount(groupBoardCards(visible, allSessions, now)));
  }
  return counts;
}

export type WorkspaceAttentionGroup = {
  key: string;
  label: string;
  attentionCount: number;
};

/**
 * Workspaces with sessions needing attention, counted from each workspace's
 * own card view so a sub-agent whose parent sits in another workspace still
 * counts where it renders standalone. Most urgent first.
 */
export function workspaceAttentionGroups(
  sessions: readonly SessionView[],
  now: number,
): WorkspaceAttentionGroup[] {
  const byWorkspace = new Map<string, { label: string; members: SessionView[] }>();
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    const entry = byWorkspace.get(key);
    if (entry === undefined) {
      byWorkspace.set(key, { label: workspaceLabelOf(session), members: [session] });
    } else {
      entry.members.push(session);
    }
  }
  const groups: (WorkspaceAttentionGroup & { latest: number })[] = [];
  for (const [key, entry] of byWorkspace) {
    const layout = groupBoardCards(entry.members, sessions, now);
    let attentionCount = 0;
    let latest = 0;
    for (const card of cardSessions(layout)) {
      if (card.needsAttention) {
        attentionCount += 1;
        latest = Math.max(latest, card.updatedAt);
      }
    }
    if (attentionCount > 0) {
      groups.push({ key, label: entry.label, attentionCount, latest });
    }
  }
  return groups
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
      deferEndedAt: null,
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
      deferEndedAt: null,
      column,
      needsAttention:
        isActiveLiveness(session.liveness) &&
        (column === "waiting_for_user" || session.pendingPermissionCount > 0),
    };
  });
}

/** Optimistic: the "延迟已结束" marker clears once the card is opened. */
export function patchDeferEndSeen<T extends WithSessions>(snapshot: T, sessionId: string): T {
  return mapSession(snapshot, sessionId, function apply(session) {
    if (session.deferEndedAt === null) {
      return session;
    }
    return { ...session, deferEndedAt: null };
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
      deferEndedAt: null,
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
