import { describe, expect, it } from "vitest";
import { AnnouncementFeed } from "./announcements";

describe("AnnouncementFeed", () => {
  it("returns events after a cursor, oldest first", () => {
    let clock = 1000;
    const feed = new AnnouncementFeed(100, () => clock, 1);
    const a = feed.push("a1", "finished", "完成了");
    clock = 2000;
    const b = feed.push("a2", "permission", "等待授权");
    expect(feed.since(0)).toEqual({ events: [a, b], cursor: 2 });
    expect(feed.since(1)).toEqual({ events: [b], cursor: 2 });
    expect(feed.since(2)).toEqual({ events: [], cursor: 2 });
    expect(b).toMatchObject({ id: 2, agentId: "a2", kind: "permission", text: "等待授权", createdAt: 2000 });
  });

  it("keeps a bounded ring, dropping the oldest", () => {
    const feed = new AnnouncementFeed(3, () => 0, 1);
    for (let index = 0; index < 5; index += 1) {
      feed.push("a", "finished", `t${index}`);
    }
    const { events, cursor } = feed.since(0);
    expect(events.map((event) => event.text)).toEqual(["t2", "t3", "t4"]);
    expect(cursor).toBe(5);
  });

  it("starts ids at the clock so restarts never reuse ids", () => {
    const feed = new AnnouncementFeed(10, () => 5000);
    expect(feed.push("a", "finished", "x").id).toBe(5000);
    expect(feed.since(0).cursor).toBe(5000);
    expect(new AnnouncementFeed(10, () => 6000).since(0)).toEqual({ events: [], cursor: 5999 });
  });
});
