import { describe, expect, it } from "vitest";
import { newRecord } from "../server/lifecycle";
import { projectView } from "../server/projection";
import type { SessionRecord } from "../server/store";
import { buildProjectFilter } from "../shared/project-filter";
import { makeSession } from "../shared/test-fixtures";
import type { Analysis } from "../shared/types";
import {
  attentionSessions,
  automaticStatus,
  cardSessions,
  columnWidthFor,
  countSubagents,
  EMPTY_SUBAGENTS,
  expandedCardIds,
  groupBoardCards,
  groupByColumn,
  isDeferred,
  openCardCount,
  patchClearDefer,
  patchClearManualStatus,
  patchDefer,
  patchDeferEndSeen,
  patchDismissResume,
  patchForget,
  patchManualStatus,
  patchReanalyze,
  patchResume,
  pollIntervalFor,
  projectCardCounts,
  reduceExpansion,
  subagentStatusOf,
  toggleCardExpansion,
  workspaceAttentionGroups,
  workspaceKeyOf,
  workspaceLabelOf,
  POLL_BUSY_MS,
  POLL_IDLE_MS,
  type ExpansionState,
} from "./board-model";

const analysis = (
  status: "completed" | "blocked" | "waiting_for_user" | "unclear" | "in_progress",
): Analysis => ({
  title: "t",
  summary: "s",
  goal: "g",
  status,
  progress: [],
  completed: [],
  nextSteps: [],
  blockers: [],
  needsUserAttention: false,
  confidence: 0.9,
});

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { ...newRecord({ id: "child", provider: "codex", cwd: "/w" }, 1), ...overrides };
}

describe("groupByColumn", () => {
  it("groups by column and sorts newest first", () => {
    const groups = groupByColumn(
      [
        makeSession({ id: "a", column: "completed", updatedAt: 1 }),
        makeSession({ id: "b", column: "completed", updatedAt: 5 }),
        makeSession({ id: "c", column: "closed", updatedAt: 2 }),
      ],
      0,
    );
    expect(groups.completed.map((s) => s.id)).toEqual(["b", "a"]);
    expect(groups.closed).toHaveLength(1);
    expect(groups.unclear).toEqual([]);
  });

  it("pins deferred cards to the bottom of their column", () => {
    const now = 1_000;
    const groups = groupByColumn(
      [
        makeSession({ id: "deferred", column: "in_progress", deferredUntil: now + 60_000, updatedAt: 9 }),
        makeSession({ id: "normal-a", column: "in_progress", updatedAt: 1 }),
        makeSession({ id: "normal-b", column: "in_progress", updatedAt: 5 }),
      ],
      now,
    );
    expect(groups.in_progress.map((s) => s.id)).toEqual(["normal-b", "normal-a", "deferred"]);
    expect(groups.deferred).toEqual([]);
  });

  it("parks queued defers in the deferred column, soonest resume first", () => {
    const now = 1_000;
    const groups = groupByColumn(
      [
        makeSession({ id: "late", column: "deferred", deferredUntil: now + 3_600_000, deferToQueue: true, updatedAt: 9 }),
        makeSession({ id: "early", column: "deferred", deferredUntil: now + 60_000, deferToQueue: true, updatedAt: 1 }),
        makeSession({ id: "normal", column: "in_progress", updatedAt: 5 }),
      ],
      now,
    );
    expect(groups.deferred.map((s) => s.id)).toEqual(["early", "late"]);
    expect(groups.in_progress.map((s) => s.id)).toEqual(["normal"]);
  });

  it("returns an expired queued defer to its status column before the next snapshot", () => {
    const now = 10_000;
    const groups = groupByColumn(
      [
        makeSession({
          id: "expired",
          column: "deferred",
          effectiveStatus: "waiting_for_user",
          deferredUntil: now - 1,
          deferToQueue: true,
          updatedAt: 5,
        }),
      ],
      now,
    );
    expect(groups.deferred).toEqual([]);
    expect(groups.waiting_for_user.map((s) => s.id)).toEqual(["expired"]);
  });

  it("keeps a queued defer in its column while still pending", () => {
    const now = 1_000;
    const groups = groupByColumn(
      [
        makeSession({
          id: "queued",
          column: "deferred",
          effectiveStatus: "completed",
          deferredUntil: now + 60_000,
          deferToQueue: true,
        }),
      ],
      now,
    );
    expect(groups.deferred.map((s) => s.id)).toEqual(["queued"]);
  });

  it("dormant sessions group into their status column, not closed", () => {
    const groups = groupByColumn(
      [
        makeSession({
          id: "dormant",
          liveness: "dormant",
          column: "waiting_for_user",
          effectiveStatus: "waiting_for_user",
        }),
        makeSession({ id: "gone", liveness: "closed", column: "closed" }),
      ],
      0,
    );
    expect(groups.waiting_for_user.map((s) => s.id)).toEqual(["dormant"]);
    expect(groups.closed.map((s) => s.id)).toEqual(["gone"]);
  });

  it("isDeferred requires an active session and a future timestamp", () => {
    const now = 1_000;
    expect(isDeferred(makeSession({ deferredUntil: now + 1 }), now)).toBe(true);
    expect(isDeferred(makeSession({ liveness: "dormant", deferredUntil: now + 1 }), now)).toBe(
      true,
    );
    expect(isDeferred(makeSession({ deferredUntil: now }), now)).toBe(false);
    expect(isDeferred(makeSession({ deferredUntil: null }), now)).toBe(false);
    expect(
      isDeferred(makeSession({ liveness: "closed", deferredUntil: now + 1 }), now),
    ).toBe(false);
  });
});

describe("groupBoardCards", () => {
  const NOW = 1_000_000;

  it("embeds a sub-agent into its parent's card", () => {
    const sessions = [
      makeSession({ id: "p", column: "in_progress", effectiveStatus: "in_progress" }),
      makeSession({
        id: "c1",
        parentAgentId: "p",
        column: "waiting_for_user",
        effectiveStatus: "waiting_for_user",
        updatedAt: 2,
      }),
      makeSession({
        id: "c2",
        parentAgentId: "p",
        column: "completed",
        effectiveStatus: "completed",
        updatedAt: 3,
      }),
      makeSession({ id: "solo", column: "completed", effectiveStatus: "completed" }),
    ];
    const layout = groupBoardCards(sessions, sessions, NOW);
    expect(layout.groups.in_progress.map((card) => card.session.id)).toEqual(["p"]);
    expect(layout.groups.waiting_for_user.map((card) => card.session.id)).toEqual([]);
    expect(layout.groups.completed.map((card) => card.session.id)).toEqual(["solo"]);
    const parent = layout.groups.in_progress[0];
    expect(parent?.children.map((child) => child.id)).toEqual(["c2", "c1"]);
    expect(parent?.detachedParent).toBeNull();
    expect(layout.hostByChildId.get("c1")).toBe("p");
    expect(layout.hostByChildId.get("c2")).toBe("p");
  });

  it("keeps the parent's column unchanged by child status", () => {
    const sessions = [
      makeSession({ id: "p", column: "completed", effectiveStatus: "completed" }),
      makeSession({
        id: "c",
        parentAgentId: "p",
        column: "waiting_for_user",
        effectiveStatus: "waiting_for_user",
        needsAttention: true,
      }),
    ];
    const layout = groupBoardCards(sessions, sessions, NOW);
    expect(layout.groups.completed.map((card) => card.session.id)).toEqual(["p"]);
    expect(layout.groups.waiting_for_user).toEqual([]);
  });

  it("renders the sub-agent standalone when the parent is closed", () => {
    const parent = makeSession({ id: "p", column: "closed", liveness: "closed" });
    const child = makeSession({
      id: "c",
      parentAgentId: "p",
      column: "in_progress",
      effectiveStatus: "in_progress",
    });
    const layout = groupBoardCards([parent, child], [parent, child], NOW);
    expect(layout.groups.in_progress.map((card) => card.session.id)).toEqual(["c"]);
    expect(layout.groups.closed.map((card) => card.session.id)).toEqual(["p"]);
    const card = layout.groups.in_progress[0];
    expect(card?.children).toEqual([]);
    expect(card?.detachedParent?.id).toBe("p");
    expect(layout.hostByChildId.has("c")).toBe(false);
  });

  it("renders the sub-agent standalone when the parent is missing", () => {
    const child = makeSession({
      id: "c",
      parentAgentId: "ghost",
      column: "in_progress",
      effectiveStatus: "in_progress",
    });
    const layout = groupBoardCards([child], [child], NOW);
    const card = layout.groups.in_progress[0];
    expect(card?.session.id).toBe("c");
    expect(card?.detachedParent).toBeNull();
  });

  it("renders the sub-agent standalone when the parent is filtered out", () => {
    const parent = makeSession({ id: "p", column: "in_progress" });
    const child = makeSession({
      id: "c",
      parentAgentId: "p",
      column: "waiting_for_user",
      effectiveStatus: "waiting_for_user",
    });
    const layout = groupBoardCards([child], [parent, child], NOW);
    const card = layout.groups.waiting_for_user[0];
    expect(card?.session.id).toBe("c");
    expect(card?.detachedParent?.id).toBe("p");
    expect(layout.hostByChildId.size).toBe(0);
    expect(cardSessions(layout).map((s) => s.id)).toEqual(["c"]);
  });

  it("embeds children of a deferred parent into its queued card", () => {
    const parent = makeSession({
      id: "p",
      column: "deferred",
      deferredUntil: NOW + 60_000,
      deferToQueue: true,
      effectiveStatus: "in_progress",
    });
    const child = makeSession({ id: "c", parentAgentId: "p", column: "in_progress" });
    const layout = groupBoardCards([parent, child], [parent, child], NOW);
    expect(layout.groups.deferred.map((card) => card.session.id)).toEqual(["p"]);
    expect(layout.groups.deferred[0]?.children.map((c) => c.id)).toEqual(["c"]);
  });

  it("flattens multi-level nesting onto the topmost visible ancestor", () => {
    const grandparent = makeSession({ id: "g", column: "in_progress" });
    const parent = makeSession({
      id: "p",
      parentAgentId: "g",
      column: "in_progress",
      updatedAt: 5,
    });
    const child = makeSession({
      id: "c",
      parentAgentId: "p",
      column: "in_progress",
      updatedAt: 9,
    });
    const sessions = [grandparent, parent, child];
    const layout = groupBoardCards(sessions, sessions, NOW);
    expect(layout.groups.in_progress.map((card) => card.session.id)).toEqual(["g"]);
    const card = layout.groups.in_progress[0];
    // Flattened children sort newest activity first, not by depth.
    expect(card?.children.map((c) => c.id)).toEqual(["c", "p"]);
    expect(layout.hostByChildId.get("p")).toBe("g");
    expect(layout.hostByChildId.get("c")).toBe("g");
  });

  it("skips a closed middle ancestor and attaches the chain to the grandparent", () => {
    const grandparent = makeSession({ id: "g", column: "in_progress" });
    const parent = makeSession({
      id: "p",
      parentAgentId: "g",
      column: "closed",
      liveness: "closed",
    });
    const child = makeSession({ id: "c", parentAgentId: "p", column: "in_progress" });
    const sessions = [grandparent, parent, child];
    const layout = groupBoardCards(sessions, sessions, NOW);
    expect(layout.groups.in_progress.map((card) => card.session.id)).toEqual(["g"]);
    // The closed middle ancestor embeds as a row too (shown as 已关闭); no closed card remains.
    expect(layout.groups.in_progress[0]?.children.map((c) => c.id).sort()).toEqual(["c", "p"]);
    expect(layout.groups.closed).toEqual([]);
    expect(layout.hostByChildId.get("p")).toBe("g");
    expect(layout.hostByChildId.get("c")).toBe("g");
  });

  it("skips a filtered-out middle ancestor and attaches to the grandparent", () => {
    const grandparent = makeSession({ id: "g", column: "in_progress" });
    const parent = makeSession({ id: "p", parentAgentId: "g", column: "in_progress" });
    const child = makeSession({ id: "c", parentAgentId: "p", column: "in_progress" });
    const layout = groupBoardCards([grandparent, child], [grandparent, parent, child], NOW);
    expect(layout.groups.in_progress.map((card) => card.session.id)).toEqual(["g"]);
    expect(layout.groups.in_progress[0]?.children.map((c) => c.id)).toEqual(["c"]);
  });

  it("breaks parent cycles without dropping any session", () => {
    const a = makeSession({ id: "a", parentAgentId: "b", column: "in_progress" });
    const b = makeSession({ id: "b", parentAgentId: "a", column: "in_progress" });
    const c = makeSession({ id: "c", parentAgentId: "a", column: "waiting_for_user" });
    const sessions = [a, b, c];
    const layout = groupBoardCards(sessions, sessions, NOW);
    const cardIds = [
      ...layout.groups.unclear,
      ...layout.groups.waiting_for_user,
      ...layout.groups.in_progress,
      ...layout.groups.completed,
      ...layout.groups.deferred,
      ...layout.groups.closed,
    ].map((card) => card.session.id);
    expect(cardIds.sort()).toEqual(["a", "b", "c"]);
    for (const card of [
      ...layout.groups.waiting_for_user,
      ...layout.groups.in_progress,
    ]) {
      expect(card.children).toEqual([]);
    }
  });

  it("treats a self-parented session as a normal card", () => {
    const self = makeSession({ id: "s", parentAgentId: "s", column: "in_progress" });
    const layout = groupBoardCards([self], [self], NOW);
    const card = layout.groups.in_progress[0];
    expect(card?.session.id).toBe("s");
    expect(card?.children).toEqual([]);
    expect(card?.detachedParent).toBeNull();
    expect(layout.hostByChildId.size).toBe(0);
  });

  it("renders a node pointing into a cycle as its own card", () => {
    const a = makeSession({ id: "a", parentAgentId: "b", column: "in_progress" });
    const b = makeSession({ id: "b", parentAgentId: "a", column: "in_progress" });
    const d = makeSession({ id: "d", parentAgentId: "a", column: "waiting_for_user" });
    const sessions = [a, b, d];
    const layout = groupBoardCards(sessions, sessions, NOW);
    const ids = cardSessions(layout).map((s) => s.id);
    expect(ids.sort()).toEqual(["a", "b", "d"]);
    expect(layout.hostByChildId.size).toBe(0);
  });

  it("embeds a closed cycle member under its live counterpart", () => {
    const a = makeSession({ id: "a", parentAgentId: "b", column: "in_progress" });
    const b = makeSession({
      id: "b",
      parentAgentId: "a",
      column: "closed",
      liveness: "closed",
    });
    const sessions = [a, b];
    const layout = groupBoardCards(sessions, sessions, NOW);
    expect(layout.groups.in_progress.map((card) => card.session.id)).toEqual(["a"]);
    expect(layout.groups.in_progress[0]?.children.map((c) => c.id)).toEqual(["b"]);
    expect(layout.groups.closed).toEqual([]);
    expect(layout.hostByChildId.get("b")).toBe("a");
  });

  it("counts children per status bucket", () => {
    const children = [
      makeSession({ id: "w", column: "waiting_for_user", effectiveStatus: "waiting_for_user" }),
      makeSession({ id: "b", column: "waiting_for_user", effectiveStatus: "blocked" }),
      makeSession({ id: "perm", column: "completed", effectiveStatus: "completed", pendingPermissionCount: 1 }),
      makeSession({ id: "run", column: "in_progress", effectiveStatus: "in_progress" }),
      makeSession({ id: "done", column: "completed", effectiveStatus: "completed" }),
      makeSession({ id: "unknown", column: "unclear", effectiveStatus: "unclear" }),
      makeSession({ id: "gone", liveness: "closed", column: "closed" }),
      makeSession({ id: "parked", column: "deferred", deferredUntil: NOW + 60_000, deferToQueue: true }),
    ];
    expect(countSubagents(children, NOW)).toEqual({
      total: 8,
      attention: 3,
      inProgress: 1,
      completed: 1,
      unclear: 1,
      deferred: 1,
      closed: 1,
    });
  });

  it("labels sub-agent rows like the board columns", () => {
    expect(
      subagentStatusOf(
        makeSession({ effectiveStatus: "blocked", column: "waiting_for_user" }),
        NOW,
      ),
    ).toMatchObject({ label: "需处理", column: "waiting_for_user", attention: true });
    expect(
      subagentStatusOf(makeSession({ liveness: "closed", column: "closed" }), NOW),
    ).toMatchObject({ label: "已关闭", column: "closed", attention: false });
    expect(
      subagentStatusOf(
        makeSession({ column: "deferred", deferredUntil: NOW + 60_000, deferToQueue: true }),
        NOW,
      ),
    ).toMatchObject({ label: "已延迟", column: "deferred", attention: false });
  });

  it("parks deferred children as 已延迟, never 需处理", () => {
    // Masked-in-place defer keeps its real column but must not count as attention.
    const masked = makeSession({
      column: "waiting_for_user",
      effectiveStatus: "waiting_for_user",
      deferredUntil: NOW + 60_000,
      deferToQueue: false,
    });
    expect(subagentStatusOf(masked, NOW)).toMatchObject({
      label: "已延迟",
      column: "deferred",
      attention: false,
    });
    // A queued defer with a pending permission is still not attention.
    const queued = makeSession({
      column: "deferred",
      effectiveStatus: "waiting_for_user",
      deferredUntil: NOW + 60_000,
      deferToQueue: true,
      pendingPermissionCount: 1,
    });
    expect(subagentStatusOf(queued, NOW)).toMatchObject({
      label: "已延迟",
      column: "deferred",
      attention: false,
    });
  });

  it("expands the host card when a hit lands on an embedded child", () => {
    const parent = makeSession({ id: "p", column: "in_progress" });
    const child = makeSession({ id: "c", parentAgentId: "p", column: "in_progress" });
    const solo = makeSession({ id: "solo", column: "in_progress" });
    const sessions = [parent, child, solo];
    const layout = groupBoardCards(sessions, sessions, NOW);
    expect([...expandedCardIds(new Set(), "c", layout.hostByChildId)].sort()).toEqual(["p"]);
    expect(expandedCardIds(new Set(["x"]), "solo", layout.hostByChildId)).toEqual(new Set(["x"]));
    expect(expandedCardIds(new Set(["x"]), null, layout.hostByChildId)).toEqual(new Set(["x"]));
  });

  it("collapses a hit-expanded card on the first click", () => {
    const parent = makeSession({ id: "p", column: "in_progress" });
    const child = makeSession({ id: "c", parentAgentId: "p", column: "in_progress" });
    const sessions = [parent, child];
    const layout = groupBoardCards(sessions, sessions, NOW);
    // The hit alone keeps "p" expanded: nothing was toggled manually.
    const displayed = expandedCardIds(new Set(), "c", layout.hostByChildId);
    const collapsed = toggleCardExpansion(
      displayed,
      new Set(),
      "c",
      layout.hostByChildId,
      "p",
    );
    expect(collapsed.toggled).toEqual(new Set());
    expect(collapsed.hitChildId).toBeNull();
    // Next clicks toggle normally.
    const expanded = toggleCardExpansion(
      expandedCardIds(collapsed.toggled, collapsed.hitChildId, layout.hostByChildId),
      collapsed.toggled,
      collapsed.hitChildId,
      layout.hostByChildId,
      "p",
    );
    expect(expanded.toggled).toEqual(new Set(["p"]));
    const collapsedAgain = toggleCardExpansion(
      expandedCardIds(expanded.toggled, expanded.hitChildId, layout.hostByChildId),
      expanded.toggled,
      expanded.hitChildId,
      layout.hostByChildId,
      "p",
    );
    expect(collapsedAgain.toggled).toEqual(new Set());
    expect(collapsedAgain.hitChildId).toBeNull();
  });

  it("keeps the hit when collapsing an unrelated card", () => {
    const parent = makeSession({ id: "p", column: "in_progress" });
    const child = makeSession({ id: "c", parentAgentId: "p", column: "in_progress" });
    const other = makeSession({ id: "o", column: "in_progress" });
    const sessions = [parent, child, other];
    const layout = groupBoardCards(sessions, sessions, NOW);
    const toggled = new Set(["o"]);
    const displayed = expandedCardIds(toggled, "c", layout.hostByChildId);
    const next = toggleCardExpansion(displayed, toggled, "c", layout.hostByChildId, "o");
    expect(next.toggled).toEqual(new Set());
    expect(next.hitChildId).toBe("c");
  });

  it("shares the EMPTY_SUBAGENTS reference across childless cards", () => {
    const layout = groupBoardCards(
      [makeSession({ id: "a" }), makeSession({ id: "b" })],
      [],
      NOW,
    );
    const [a, b] = layout.groups.unclear;
    expect(a?.children).toBe(EMPTY_SUBAGENTS);
    expect(b?.children).toBe(EMPTY_SUBAGENTS);
    expect(a?.children).toBe(b?.children);
  });
});

describe("view-level card counts", () => {
  const NOW = 1_000_000;

  function countsFor(sessions: ReturnType<typeof makeSession>[]) {
    const filter = buildProjectFilter(sessions);
    return projectCardCounts(
      sessions,
      filter.projectKeyBySessionId,
      filter.options.map(function keyOf(option) {
        return option.key;
      }),
      NOW,
    );
  }

  it("counts cards per project from each project's own view", () => {
    const parent = makeSession({ id: "p", projectKey: "A", updatedAt: 30 });
    const c1 = makeSession({
      id: "c1",
      projectKey: "B",
      parentAgentId: "p",
      column: "waiting_for_user",
      effectiveStatus: "waiting_for_user",
      needsAttention: true,
      updatedAt: 20,
    });
    const c2 = makeSession({ id: "c2", projectKey: "B", parentAgentId: "p", updatedAt: 10 });
    const all = [parent, c1, c2];
    const counts = countsFor(all);
    // Under A's view the parent renders alone (children filtered out);
    // under B's view the parent is filtered out so both children stand alone.
    expect(counts.get("A")).toBe(1);
    expect(counts.get("B")).toBe(2);
    // The unfiltered layout embeds both children: a single open card, and it
    // must not equal the sum of chip counts.
    expect(openCardCount(groupBoardCards(all, all, NOW))).toBe(1);
  });

  it("counts a standalone child under a closed parent in its own view", () => {
    const closedParent = makeSession({
      id: "p",
      projectKey: "A",
      column: "closed",
      liveness: "closed",
    });
    const child = makeSession({
      id: "c",
      projectKey: "B",
      parentAgentId: "p",
      column: "waiting_for_user",
      effectiveStatus: "waiting_for_user",
      needsAttention: true,
    });
    const counts = countsFor([closedParent, child]);
    expect(counts.get("A")).toBe(0); // closed card excluded from open count
    expect(counts.get("B")).toBe(1);
  });

  it("counts cycle members as standalone cards per view", () => {
    const a = makeSession({ id: "a", projectKey: "A", parentAgentId: "b" });
    const b = makeSession({ id: "b", projectKey: "A", parentAgentId: "a" });
    const counts = countsFor([a, b]);
    expect(counts.get("A")).toBe(2);
  });

  it("counts detached sub-agents in the unfiltered layout only as their own card", () => {
    const parent = makeSession({ id: "p", projectKey: "A", column: "closed", liveness: "closed" });
    const child = makeSession({ id: "c", projectKey: "A", parentAgentId: "p" });
    const all = [parent, child];
    // Same project: the child is standalone under every view, so the open
    // count is 1 (the child) and the closed parent never counts.
    expect(openCardCount(groupBoardCards(all, all, NOW))).toBe(1);
    expect(countsFor(all).get("A")).toBe(1);
  });
});

describe("reduceExpansion", () => {
  const NOW = 1_000_000;

  it("collapses a hit-expanded card on the first toggle, then toggles normally", () => {
    const parent = makeSession({ id: "p", column: "in_progress" });
    const child = makeSession({ id: "c", parentAgentId: "p", column: "in_progress" });
    const layout = groupBoardCards([parent, child], [parent, child], NOW);
    let state: ExpansionState = { toggled: new Set(), hitChildId: null };
    state = reduceExpansion(state, { type: "hit", childId: "c" });
    expect(state.hitChildId).toBe("c");
    state = reduceExpansion(state, {
      type: "toggle",
      cardId: "p",
      hostByChildId: layout.hostByChildId,
    });
    expect(state).toEqual({ toggled: new Set(), hitChildId: null });
    expect(
      expandedCardIds(state.toggled, state.hitChildId, layout.hostByChildId).has("p"),
    ).toBe(false);
    state = reduceExpansion(state, {
      type: "toggle",
      cardId: "p",
      hostByChildId: layout.hostByChildId,
    });
    expect(state.toggled).toEqual(new Set(["p"]));
  });
});

describe("subagentStatusOf parity with projectView().needsAttention", () => {
  const NOW = 10_000;
  const cases: { name: string; overrides: Partial<SessionRecord> }[] = [
    { name: "live idle", overrides: {} },
    { name: "live working", overrides: { lifecycle: "working" } },
    { name: "live waiting analysis", overrides: { analysis: analysis("waiting_for_user") } },
    { name: "live blocked analysis", overrides: { analysis: analysis("blocked") } },
    { name: "live pending permission", overrides: { pendingPermissionCount: 1 } },
    {
      name: "manual override completed still counts pending permission",
      overrides: { manualStatusOverride: "completed", pendingPermissionCount: 1 },
    },
    { name: "dormant plain", overrides: { liveness: "dormant" } },
    { name: "dormant interrupted", overrides: { liveness: "dormant", interruptedAt: 5 } },
    {
      name: "dormant queued defer",
      overrides: { liveness: "dormant", deferredUntil: NOW + 60_000, deferToQueue: true },
    },
    {
      name: "closed",
      overrides: { liveness: "closed", analysis: analysis("waiting_for_user") },
    },
    { name: "archived", overrides: { liveness: "archived", pendingPermissionCount: 1 } },
    {
      name: "queued defer with pending permission",
      overrides: { deferredUntil: NOW + 60_000, deferToQueue: true, pendingPermissionCount: 1 },
    },
    {
      name: "masked defer with pending permission",
      overrides: { deferredUntil: NOW + 60_000, deferToQueue: false, pendingPermissionCount: 1 },
    },
    {
      name: "expired defer",
      overrides: { deferredUntil: NOW - 1, deferToQueue: true, pendingPermissionCount: 1 },
    },
    {
      name: "defer boundary deferredUntil === now",
      overrides: { deferredUntil: NOW, deferToQueue: true, pendingPermissionCount: 1 },
    },
  ];
  for (const c of cases) {
    it(`matches needsAttention: ${c.name}`, () => {
      const view = projectView(record(c.overrides), NOW);
      const status = subagentStatusOf(view, NOW);
      expect(status.attention).toBe(view.needsAttention);
      // A deferred view must always surface 已延迟, never 需处理.
      expect(status.label === "已延迟").toBe(isDeferred(view, NOW));
    });
  }
});

describe("attentionSessions", () => {
  it("returns the newest attention sessions up to the limit", () => {
    const list = [
      makeSession({ id: "a", needsAttention: true, updatedAt: 1 }),
      makeSession({ id: "b", needsAttention: false, updatedAt: 9 }),
      makeSession({ id: "c", needsAttention: true, updatedAt: 3 }),
    ];
    expect(attentionSessions(list, 1).map((s) => s.id)).toEqual(["c"]);
    expect(attentionSessions(list, 8).map((s) => s.id)).toEqual(["c", "a"]);
  });
});

describe("workspaceAttentionGroups", () => {
  it("counts only attention sessions, keyed by workspace id", () => {
    const groups = workspaceAttentionGroups(
      [
        makeSession({ id: "a", needsAttention: true, workspaceId: "ws-1", updatedAt: 1 }),
        makeSession({ id: "b", needsAttention: true, workspaceId: "ws-1", updatedAt: 3 }),
        makeSession({ id: "c", needsAttention: true, workspaceId: "ws-2", updatedAt: 2 }),
        makeSession({ id: "d", needsAttention: false, workspaceId: "ws-3", updatedAt: 9 }),
      ],
      0,
    );
    expect(groups).toEqual([
      { key: "ws:ws-1", label: "App", attentionCount: 2 },
      { key: "ws:ws-2", label: "App", attentionCount: 1 },
    ]);
  });

  it("falls back to projectKey then cwd for the key, and names for the label", () => {
    const proj = makeSession({ workspaceId: null, projectKey: "p9", projectName: "Beta" });
    const dir = makeSession({
      workspaceId: null,
      projectKey: null,
      projectName: null,
      workspaceName: null,
      cwd: "/x/y/plugin",
    });
    expect(workspaceKeyOf(proj)).toBe("proj:p9");
    expect(workspaceKeyOf(dir)).toBe("cwd:/x/y/plugin");
    expect(workspaceLabelOf(proj)).toBe("Beta");
    expect(workspaceLabelOf(dir)).toBe("plugin");
    expect(workspaceLabelOf(makeSession({ workspaceName: " 工作台 " }))).toBe("工作台");
  });

  it("sorts groups by the newest attention update", () => {
    const groups = workspaceAttentionGroups(
      [
        makeSession({ id: "a", needsAttention: true, workspaceId: "old", updatedAt: 1 }),
        makeSession({ id: "b", needsAttention: true, workspaceId: "new", updatedAt: 5 }),
      ],
      0,
    );
    expect(groups.map((g) => g.key)).toEqual(["ws:new", "ws:old"]);
  });

  it("counts a detached sub-agent toward its own workspace, not its parent's", () => {
    const parent = makeSession({
      id: "p",
      workspaceId: "w1",
      workspaceName: "W1",
      updatedAt: 30,
    });
    const child = makeSession({
      id: "c",
      workspaceId: "w2",
      workspaceName: "W2",
      parentAgentId: "p",
      needsAttention: true,
      column: "waiting_for_user",
      effectiveStatus: "waiting_for_user",
      updatedAt: 20,
    });
    // Globally the child embeds under the parent; under its own workspace's
    // view it is standalone, so the count lands on ws:w2.
    const groups = workspaceAttentionGroups([parent, child], 0);
    expect(groups).toEqual([{ key: "ws:w2", label: "W2", attentionCount: 1 }]);
  });
});

describe("pollIntervalFor", () => {
  it("is fast while analysis is queued/running or seeding", () => {
    expect(pollIntervalFor(undefined)).toBe(POLL_IDLE_MS);
    expect(pollIntervalFor({ sessions: [makeSession()] })).toBe(POLL_IDLE_MS);
    expect(
      pollIntervalFor({ sessions: [makeSession({ analysisState: "running" })] }),
    ).toBe(POLL_BUSY_MS);
    expect(pollIntervalFor({ sessions: [], seeding: true })).toBe(POLL_BUSY_MS);
  });
});

describe("optimistic patches", () => {
  it("sets a manual status and moves the column", () => {
    const snap = { sessions: [makeSession({ id: "a" })] };
    const next = patchManualStatus(snap, "a", "completed");
    expect(next.sessions[0]).toMatchObject({
      manualStatusOverride: "completed",
      effectiveStatus: "completed",
      column: "completed",
      needsAttention: false,
    });
    expect(snap.sessions[0].manualStatusOverride).toBeNull();
  });

  it("blocked lands in the attention column", () => {
    const next = patchManualStatus({ sessions: [makeSession({ id: "a" })] }, "a", "blocked");
    expect(next.sessions[0]).toMatchObject({ column: "waiting_for_user", needsAttention: true });
  });

  it("ignores non-live sessions", () => {
    const closed = makeSession({ id: "a", liveness: "closed", column: "closed" });
    expect(patchManualStatus({ sessions: [closed] }, "a", "completed").sessions[0]).toEqual(closed);
  });

  it("clears the override back to the automatic status", () => {
    const session = makeSession({
      id: "a",
      manualStatusOverride: "completed",
      effectiveStatus: "completed",
      column: "completed",
      modelStatus: "in_progress",
    });
    const next = patchClearManualStatus({ sessions: [session] }, "a");
    expect(next.sessions[0]).toMatchObject({
      manualStatusOverride: null,
      effectiveStatus: "in_progress",
      column: "in_progress",
    });
  });

  it("clear prefers pending permission then working lifecycle", () => {
    const perm = makeSession({ id: "a", pendingPermissionCount: 1, modelStatus: "completed" });
    expect(patchClearManualStatus({ sessions: [perm] }, "a").sessions[0].column).toBe(
      "waiting_for_user",
    );
    const working = makeSession({ id: "a", lifecycle: "working", modelStatus: "completed" });
    expect(patchClearManualStatus({ sessions: [working] }, "a").sessions[0].column).toBe(
      "in_progress",
    );
  });

  it("marks reanalyze as queued and forget removes the card", () => {
    const snap = { sessions: [makeSession({ id: "a" }), makeSession({ id: "b" })] };
    expect(patchReanalyze(snap, "a").sessions[0].analysisState).toBe("queued");
    expect(patchForget(snap, "a").sessions.map((s) => s.id)).toEqual(["b"]);
  });

  it("defers into the queue column and clears attention", () => {
    const snap = {
      sessions: [
        makeSession({
          id: "a",
          column: "waiting_for_user",
          effectiveStatus: "waiting_for_user",
          needsAttention: true,
        }),
      ],
    };
    const next = patchDefer(snap, "a", 1_700_000_000_000, true);
    expect(next.sessions[0]).toMatchObject({
      deferredUntil: 1_700_000_000_000,
      deferToQueue: true,
      column: "deferred",
      needsAttention: false,
    });
  });

  it("defers in place and keeps its column", () => {
    const snap = { sessions: [makeSession({ id: "a", column: "in_progress" })] };
    const next = patchDefer(snap, "a", 123, false);
    expect(next.sessions[0]).toMatchObject({
      deferredUntil: 123,
      deferToQueue: false,
      column: "in_progress",
    });
  });

  it("a fresh defer drops a stale defer-end marker", () => {
    const snap = {
      sessions: [makeSession({ id: "a", column: "completed", deferEndedAt: 50 })],
    };
    const next = patchDefer(snap, "a", 123, false);
    expect(next.sessions[0]).toMatchObject({ deferredUntil: 123, deferEndedAt: null });
  });

  it("re-deferring out of the queue restores the status column", () => {
    const snap = {
      sessions: [
        makeSession({
          id: "a",
          column: "deferred",
          effectiveStatus: "completed",
          deferredUntil: 999,
          deferToQueue: true,
        }),
      ],
    };
    const next = patchDefer(snap, "a", 1234, false);
    expect(next.sessions[0]).toMatchObject({ column: "completed", deferToQueue: false });
  });

  it("ignores defer for non-live sessions", () => {
    const closed = makeSession({ id: "a", liveness: "closed", column: "closed" });
    expect(patchDefer({ sessions: [closed] }, "a", 123, true).sessions[0]).toEqual(closed);
  });

  it("clearing defer restores the column and attention", () => {
    const snap = {
      sessions: [
        makeSession({
          id: "a",
          column: "deferred",
          effectiveStatus: "waiting_for_user",
          deferredUntil: 999,
          deferToQueue: true,
          deferEndedAt: 500,
          needsAttention: false,
        }),
      ],
    };
    const next = patchClearDefer(snap, "a");
    expect(next.sessions[0]).toMatchObject({
      deferredUntil: null,
      deferToQueue: false,
      deferEndedAt: null,
      column: "waiting_for_user",
      needsAttention: true,
    });
  });

  it("patchDeferEndSeen clears only the defer-end marker", () => {
    const snap = {
      sessions: [
        makeSession({ id: "a", column: "in_progress", deferEndedAt: 500 }),
        makeSession({ id: "b", deferEndedAt: null }),
      ],
    };
    const next = patchDeferEndSeen(snap, "a");
    expect(next.sessions[0].deferEndedAt).toBeNull();
    expect(next.sessions[0].column).toBe("in_progress");
    expect(patchDeferEndSeen({ sessions: [next.sessions[1]] }, "b").sessions[0]).toEqual(
      next.sessions[1],
    );
  });

  it("automaticStatus prioritizes the restart interruption flag", () => {
    const interrupted = makeSession({
      liveness: "dormant",
      interruptedAt: 5,
      modelStatus: "completed",
    });
    expect(automaticStatus(interrupted)).toBe("waiting_for_user");
    const live = makeSession({ interruptedAt: 5, lifecycle: "working" });
    expect(automaticStatus(live)).toBe("waiting_for_user");
  });

  it("patchResume shows 恢复中 only on dormant sessions", () => {
    const dormant = makeSession({ id: "d", liveness: "dormant", column: "waiting_for_user" });
    const next = patchResume({ sessions: [dormant] }, "d");
    expect(next.sessions[0]).toMatchObject({ resumeState: "resuming", resumeError: null });
    const live = makeSession({ id: "l" });
    expect(patchResume({ sessions: [live] }, "l").sessions[0]).toEqual(live);
  });

  it("patchDismissResume drops the card into the closed column", () => {
    const dormant = makeSession({
      id: "d",
      liveness: "dormant",
      column: "waiting_for_user",
      interruptedAt: 5,
      resumeState: "failed",
      resumeError: "恢复失败：x",
      deferredUntil: 999,
      deferToQueue: true,
    });
    const next = patchDismissResume({ sessions: [dormant] }, "d");
    expect(next.sessions[0]).toMatchObject({
      liveness: "closed",
      column: "closed",
      interruptedAt: null,
      resumeState: "idle",
      resumeError: null,
      deferredUntil: null,
      deferToQueue: false,
      needsAttention: false,
    });
  });

  it("pollIntervalFor stays busy while a resume is queued or running", () => {
    expect(
      pollIntervalFor({ sessions: [makeSession({ resumeState: "resuming" })] }),
    ).toBe(POLL_BUSY_MS);
    expect(
      pollIntervalFor({ sessions: [makeSession({ resumeState: "queued" })] }),
    ).toBe(POLL_BUSY_MS);
    expect(
      pollIntervalFor({ sessions: [makeSession({ resumeState: "failed" })] }),
    ).toBe(POLL_IDLE_MS);
  });
});

describe("columnWidthFor", () => {
  it("returns null before the container is measured", () => {
    expect(columnWidthFor(0, 60, 5)).toBeNull();
  });

  it("scales the fill width by the percentage", () => {
    // fill = (1824 - 24 - 48) / 5 = 350.4
    expect(columnWidthFor(1824, 100, 5)).toBe(350);
    expect(columnWidthFor(1824, 60, 5)).toBe(210);
  });

  it("never goes below the minimum width", () => {
    expect(columnWidthFor(900, 30, 5)).toBe(200);
  });

  it("allows columns wider than the fill width, up to 500%", () => {
    expect(columnWidthFor(1824, 150, 5)).toBe(525);
    expect(columnWidthFor(1824, 600, 5)).toBe(columnWidthFor(1824, 500, 5));
  });
});
