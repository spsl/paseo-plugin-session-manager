import { describe, expect, it } from "vitest";
import { makeSession } from "../shared/test-fixtures";
import {
  attentionSessions,
  automaticStatus,
  columnWidthFor,
  groupByColumn,
  isDeferred,
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
  workspaceAttentionGroups,
  workspaceKeyOf,
  workspaceLabelOf,
  POLL_BUSY_MS,
  POLL_IDLE_MS,
} from "./board-model";

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
    const groups = workspaceAttentionGroups([
      makeSession({ id: "a", needsAttention: true, workspaceId: "ws-1", updatedAt: 1 }),
      makeSession({ id: "b", needsAttention: true, workspaceId: "ws-1", updatedAt: 3 }),
      makeSession({ id: "c", needsAttention: true, workspaceId: "ws-2", updatedAt: 2 }),
      makeSession({ id: "d", needsAttention: false, workspaceId: "ws-3", updatedAt: 9 }),
    ]);
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
    const groups = workspaceAttentionGroups([
      makeSession({ id: "a", needsAttention: true, workspaceId: "old", updatedAt: 1 }),
      makeSession({ id: "b", needsAttention: true, workspaceId: "new", updatedAt: 5 }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["ws:new", "ws:old"]);
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
