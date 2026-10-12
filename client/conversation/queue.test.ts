import { describe, expect, it, vi } from "vitest";
import {
  enqueueMessage,
  popQueuedMessage,
  queueFor,
  removeQueuedMessage,
  subscribeQueue,
} from "./queue";

describe("composer queue", () => {
  it("enqueues in order, removes and pops", () => {
    const sid = "t-queue-1";
    const a = enqueueMessage(sid, "第一条");
    const b = enqueueMessage(sid, "第二条");
    expect(queueFor(sid).map((m) => m.text)).toEqual(["第一条", "第二条"]);
    expect(popQueuedMessage(sid, a.id)).toBe("第一条");
    expect(queueFor(sid).map((m) => m.id)).toEqual([b.id]);
    expect(removeQueuedMessage(sid, "missing")).toBeNull();
    expect(removeQueuedMessage(sid, b.id)?.id).toBe(b.id);
    expect(queueFor(sid)).toHaveLength(0);
  });

  it("notifies subscribers with the session id", () => {
    const sid = "t-queue-2";
    const listener = vi.fn();
    const off = subscribeQueue(listener);
    enqueueMessage(sid, "x");
    expect(listener).toHaveBeenCalledWith(sid);
    off();
    enqueueMessage(sid, "y");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
