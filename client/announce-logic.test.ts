import { describe, expect, it } from "vitest";
import type { Announcement } from "../shared/speech";
import { MAX_BACKOFF_MS, POLL_MS, nextDelay, pickFresh } from "./announce-logic";

const event = (id: number): Announcement => ({ id, agentId: "a", kind: "finished", text: `t${id}`, createdAt: id });

describe("pickFresh", () => {
  it("seeds on the first poll without speaking anything", () => {
    const seen = new Set<number>();
    const result = pickFresh([event(1), event(2)], 2, 0, seen, true);
    expect(result).toEqual({ fresh: [], since: 2 });
    expect(pickFresh([event(1), event(2)], 2, 2, seen, false).fresh).toEqual([]);
  });

  it("returns new events once, oldest first, and dedupes repeats", () => {
    const seen = new Set<number>([1]);
    const first = pickFresh([event(3), event(2), event(1)], 3, 1, seen, false);
    expect(first.fresh.map((e) => e.id)).toEqual([2, 3]);
    expect(first.since).toBe(3);
    expect(pickFresh([event(3)], 3, 3, seen, false).fresh).toEqual([]);
  });

  it("never moves the cursor backwards", () => {
    expect(pickFresh([], 1, 9, new Set(), false).since).toBe(9);
  });
});

describe("nextDelay", () => {
  it("polls steadily, then backs off to a cap", () => {
    expect(nextDelay(0)).toBe(POLL_MS);
    expect(nextDelay(1)).toBe(POLL_MS * 2);
    expect(nextDelay(2)).toBe(POLL_MS * 4);
    expect(nextDelay(20)).toBe(MAX_BACKOFF_MS);
  });
});
