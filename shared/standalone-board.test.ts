import { describe, expect, it } from "vitest";
import {
  buildStandaloneBoardUrl,
  createHandoff,
  decideHandoff,
  HANDOFF_MAX_AGE_MS,
} from "./standalone-board";

describe("decideHandoff", () => {
  const now = 1_000_000;
  it("ignores a missing flag", () => {
    expect(decideHandoff(null, now, "a")).toBe("ignore");
  });
  it("consumes a fresh flag from another window", () => {
    expect(decideHandoff(createHandoff(now - 1000, "a"), now, "b")).toBe("consume");
  });
  it("never consumes its own flag", () => {
    expect(decideHandoff(createHandoff(now - 1000, "a"), now, "a")).toBe("ignore");
  });
  it("discards stale and garbled flags", () => {
    expect(decideHandoff(createHandoff(now - HANDOFF_MAX_AGE_MS - 1, "a"), now, "b")).toBe("discard");
    expect(decideHandoff("nope", now, "b")).toBe("discard");
    expect(decideHandoff('{"at":"x"}', now, "b")).toBe("discard");
  });
});

describe("buildStandaloneBoardUrl", () => {
  it("extracts the server id", () => {
    expect(buildStandaloneBoardUrl("paseo://app/h/srv1/workspace/x?y=1")).toBe(
      "paseo://app/h/srv1/plugin/session-manager/surface/board?param.standalone=1",
    );
    expect(buildStandaloneBoardUrl("paseo://app/h/srv1")).toContain("/h/srv1/");
  });
  it("returns null without a host segment", () => {
    expect(buildStandaloneBoardUrl("paseo://app/")).toBeNull();
  });
});
