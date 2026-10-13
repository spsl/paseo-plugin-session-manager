import { describe, expect, it, vi } from "vitest";
import {
  enqueueMessage,
  queueFor,
  queuedSessionIds,
  requeueFront,
  subscribeQueue,
  takeQueuedMessage,
} from "./queue";

describe("composer queue", () => {
  it("enqueues in order with text and images, takes and requeues at the front", () => {
    const sid = "t-queue-1";
    const image = { id: "i1", mimeType: "image/png", data: "AAA", uri: "u" };
    const a = enqueueMessage(sid, { text: "第一条", images: [image] });
    const b = enqueueMessage(sid, { text: "第二条", images: [] });
    expect(queueFor(sid).map((m) => m.text)).toEqual(["第一条", "第二条"]);
    expect(queueFor(sid)[0].images).toEqual([image]);
    expect(queuedSessionIds()).toContain(sid);

    expect(takeQueuedMessage(sid, "missing")).toBeNull();
    expect(takeQueuedMessage(sid, a.id)?.text).toBe("第一条");
    expect(queueFor(sid).map((m) => m.id)).toEqual([b.id]);

    requeueFront(sid, a);
    expect(queueFor(sid).map((m) => m.id)).toEqual([a.id, b.id]);

    takeQueuedMessage(sid, a.id);
    takeQueuedMessage(sid, b.id);
    expect(queueFor(sid)).toHaveLength(0);
    expect(queuedSessionIds()).not.toContain(sid);
  });

  it("notifies subscribers with the session id", () => {
    const sid = "t-queue-2";
    const listener = vi.fn();
    const off = subscribeQueue(listener);
    enqueueMessage(sid, { text: "x", images: [] });
    expect(listener).toHaveBeenCalledWith(sid);
    off();
    enqueueMessage(sid, { text: "y", images: [] });
    expect(listener).toHaveBeenCalledTimes(1);
    takeQueuedMessage(sid, queueFor(sid)[0].id);
    takeQueuedMessage(sid, queueFor(sid)[0].id);
  });
});
