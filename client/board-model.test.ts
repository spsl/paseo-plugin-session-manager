import { describe, expect, it } from "vitest";
import { makeSession } from "../shared/test-fixtures";
import {
  attentionSessions,
  columnWidthFor,
  groupByColumn,
  patchClearManualStatus,
  patchForget,
  patchManualStatus,
  patchReanalyze,
  pollIntervalFor,
  POLL_BUSY_MS,
  POLL_IDLE_MS,
} from "./board-model";

describe("groupByColumn", () => {
  it("groups by column and sorts newest first", () => {
    const groups = groupByColumn([
      makeSession({ id: "a", column: "completed", updatedAt: 1 }),
      makeSession({ id: "b", column: "completed", updatedAt: 5 }),
      makeSession({ id: "c", column: "closed", updatedAt: 2 }),
    ]);
    expect(groups.completed.map((s) => s.id)).toEqual(["b", "a"]);
    expect(groups.closed).toHaveLength(1);
    expect(groups.unclear).toEqual([]);
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
});
