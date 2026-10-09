import { describe, expect, it } from "vitest";
import { makeSession } from "../shared/test-fixtures";
import { resolveDrop } from "./drag-logic";

describe("resolveDrop", () => {
  const session = makeSession({ column: "unclear", effectiveStatus: "unclear" });
  it("drops on a different column", () => {
    expect(resolveDrop(session, "completed")).toEqual({ kind: "drop", status: "completed" });
  });
  it("is a no-op outside columns or on the own column", () => {
    expect(resolveDrop(session, null)).toEqual({ kind: "noop" });
    expect(resolveDrop(session, "unclear")).toEqual({ kind: "noop" });
  });
  it("rejects the closed column", () => {
    expect(resolveDrop(session, "closed")).toEqual({ kind: "reject", message: "已关闭列不能拖入" });
  });
  it("never drops non-live sessions", () => {
    const closed = makeSession({ liveness: "closed", column: "closed" });
    expect(resolveDrop(closed, "completed")).toEqual({ kind: "noop" });
  });
});
