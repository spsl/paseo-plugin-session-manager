import { describe, expect, it } from "vitest";
import { canDrop, hitTestColumn, statusForColumn, type ColumnRect } from "./drop-target";
import { makeSession } from "./test-fixtures";

const rects: ColumnRect[] = [
  { id: "unclear", x: 0, y: 0, width: 100, height: 400 },
  { id: "waiting_for_user", x: 110, y: 0, width: 100, height: 400 },
];

describe("drop target", () => {
  it("hit-tests columns and misses gaps", () => {
    expect(hitTestColumn(rects, 50, 10)).toBe("unclear");
    expect(hitTestColumn(rects, 150, 399)).toBe("waiting_for_user");
    expect(hitTestColumn(rects, 105, 10)).toBeNull();
    expect(hitTestColumn(rects, 50, 500)).toBeNull();
  });

  it("maps columns to statuses, closed to null", () => {
    expect(statusForColumn("completed")).toBe("completed");
    expect(statusForColumn("closed")).toBeNull();
  });

  it("only allows live sessions to drop on a different open column", () => {
    const live = makeSession({ effectiveStatus: "in_progress", column: "in_progress" });
    expect(canDrop(live, "completed")).toBe(true);
    expect(canDrop(live, "in_progress")).toBe(false);
    expect(canDrop(live, "closed")).toBe(false);
    expect(canDrop(makeSession({ liveness: "closed", column: "closed" }), "completed")).toBe(false);
    expect(canDrop(makeSession({ liveness: "archived", column: "closed" }), "completed")).toBe(false);
  });

  it("allows overriding to the status already shown only when there is an override elsewhere", () => {
    // Auto status is unclear but the card shows waiting_for_user via override: dropping on
    // 'unclear' is a real change, dropping on the current column is not.
    const overridden = makeSession({
      manualStatusOverride: "waiting_for_user",
      effectiveStatus: "waiting_for_user",
      column: "waiting_for_user",
    });
    expect(canDrop(overridden, "unclear")).toBe(true);
    expect(canDrop(overridden, "waiting_for_user")).toBe(false);
  });

  it("rejects a drop equal to the effective status when there is no override", () => {
    // Blocked sits in the needs-action column; the effective status is already blocked
    // so a no-override drop onto the same column is rejected.
    const blocked = makeSession({ effectiveStatus: "blocked", column: "waiting_for_user" });
    expect(canDrop(blocked, "waiting_for_user")).toBe(false);
  });
});
