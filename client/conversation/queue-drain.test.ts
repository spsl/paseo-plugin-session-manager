import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeHandlers = {
  snapshot(): void;
  update(message: { type: string }): void;
  error(error: unknown): void;
};

type FakeHandle = {
  status: string;
  activeTurn: unknown;
  archivedAt: string | null;
  refresh: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
};

function setup() {
  const handlersBox: { handlers: FakeHandlers | null } = { handlers: null };
  const scripted: string[] = [];
  const handle: FakeHandle = {
    status: "idle",
    activeTurn: null,
    archivedAt: null,
    refresh: vi.fn(async function refresh() {
      const next = scripted.shift();
      if (next !== undefined) {
        handle.status = next;
      }
      return null;
    }),
    send: vi.fn(async function send() {
      return undefined;
    }),
  };
  const paseo = {
    agents: {
      ref: vi.fn(function ref() {
        return handle;
      }),
      list: vi.fn(async function list() {
        return {
          entries: [],
          pageInfo: {},
          requestId: "r1",
          subscriptionId: "sub1",
          subscription: {
            subscribe(handlers: FakeHandlers) {
              handlersBox.handlers = handlers;
            },
            async release() {
              return undefined;
            },
          },
        };
      }),
    },
  };
  return { handle, paseo, scripted, handlersBox };
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

describe("queue drain", () => {
  beforeEach(function useFake() {
    vi.useFakeTimers();
  });
  afterEach(function restore() {
    vi.useRealTimers();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("drainTrigger: stopped transition only", async () => {
    const drain = await import("./queue-drain");
    expect(drain.drainTrigger(true, { status: "idle", activeTurn: null })).toBe("stopped");
    expect(drain.drainTrigger(false, { status: "idle", activeTurn: null })).toBeNull();
    expect(drain.drainTrigger(undefined, { status: "idle", activeTurn: null })).toBeNull();
    expect(drain.drainTrigger(true, { status: "running", activeTurn: null })).toBeNull();
    expect(drain.isRunning({ status: "initializing", activeTurn: null })).toBe(true);
    expect(drain.isRunning({ status: "idle", activeTurn: { turnId: "t" } })).toBe(true);
    expect(drain.isRunning({ status: "idle", activeTurn: null })).toBe(false);
  });

  it("sends the queue head with steer when the agent stops", async () => {
    const { handle, paseo, handlersBox } = setup();
    const queue = await import("./queue");
    const drain = await import("./queue-drain");
    queue.enqueueMessage("s1", { text: "一", images: [] });
    queue.enqueueMessage("s1", { text: "二", images: [] });
    drain.ensureQueueDrain(paseo as never);
    await tick(10);

    handle.status = "running";
    handlersBox.handlers?.update({ type: "agent_update" });
    await tick(300);
    expect(handle.send).not.toHaveBeenCalled();

    handle.status = "idle";
    handlersBox.handlers?.update({ type: "agent_update" });
    await tick(300);
    expect(handle.send).toHaveBeenCalledTimes(1);
    expect(handle.send).toHaveBeenCalledWith("一", { activeTurnBehavior: "steer" });
    expect(queue.queueFor("s1").map((m) => m.text)).toEqual(["二"]);
  });

  it("does not send on an always-idle observation without arming", async () => {
    const { handle, paseo, handlersBox } = setup();
    const queue = await import("./queue");
    const drain = await import("./queue-drain");
    queue.enqueueMessage("s2", { text: "x", images: [] });
    drain.ensureQueueDrain(paseo as never);
    await tick(10);

    handle.status = "idle";
    handlersBox.handlers?.update({ type: "agent_update" });
    await tick(300);
    await tick(4000);
    expect(handle.send).not.toHaveBeenCalled();
    expect(queue.queueFor("s2")).toHaveLength(1);
  });

  it("markQueuedWhileRunning drains on the first idle observation", async () => {
    const { handle, paseo, handlersBox } = setup();
    const queue = await import("./queue");
    const drain = await import("./queue-drain");
    queue.enqueueMessage("s3", { text: "x", images: [] });
    drain.markQueuedWhileRunning("s3");
    drain.ensureQueueDrain(paseo as never);
    await tick(10);

    handle.status = "idle";
    handlersBox.handlers?.update({ type: "agent_update" });
    await tick(300);
    expect(handle.send).toHaveBeenCalledTimes(1);
  });

  it("nudge sends immediately; concurrent nudges are deduped", async () => {
    const { handle, paseo } = setup();
    const queue = await import("./queue");
    const drain = await import("./queue-drain");
    const releaseBox: { fn: (() => void) | null } = { fn: null };
    handle.send.mockImplementation(
      () =>
        new Promise<void>(function hold(resolve) {
          releaseBox.fn = resolve;
        }),
    );
    queue.enqueueMessage("s4", { text: "x", images: [] });
    drain.ensureQueueDrain(paseo as never);
    await tick(10);

    drain.nudgeQueueDrain("s4");
    drain.nudgeQueueDrain("s4");
    await tick(10);
    expect(handle.send).toHaveBeenCalledTimes(1);
    releaseBox.fn?.();
    await tick(10);
    expect(queue.queueFor("s4")).toHaveLength(0);
  });

  it("skips when the pre-send recheck finds the agent running", async () => {
    const { handle, paseo, scripted } = setup();
    const queue = await import("./queue");
    const drain = await import("./queue-drain");
    queue.enqueueMessage("s5", { text: "x", images: [] });
    drain.ensureQueueDrain(paseo as never);
    await tick(10);

    scripted.push("running");
    drain.nudgeQueueDrain("s5");
    await tick(10);
    expect(handle.send).not.toHaveBeenCalled();
    expect(queue.queueFor("s5")).toHaveLength(1);
  });

  it("a failed send requeues at the head, warns, and does not retry until a real trigger", async () => {
    const { handle, paseo, handlersBox } = setup();
    const queue = await import("./queue");
    const drain = await import("./queue-drain");
    const warn = vi.spyOn(console, "warn").mockImplementation(function silent() {
      return undefined;
    });
    queue.enqueueMessage("s6", { text: "x", images: [] });
    drain.markQueuedWhileRunning("s6");
    drain.ensureQueueDrain(paseo as never);
    await tick(10);

    handle.send.mockRejectedValueOnce(new Error("daemon down"));
    handle.status = "idle";
    handlersBox.handlers?.update({ type: "agent_update" });
    await tick(300);
    expect(handle.send).toHaveBeenCalledTimes(1);
    expect(queue.queueFor("s6").map((m) => m.text)).toEqual(["x"]);
    expect(warn).toHaveBeenCalled();

    // Idle updates and the 3s safety refresh must not retry.
    handle.send.mockClear();
    handlersBox.handlers?.update({ type: "agent_update" });
    await tick(300);
    await tick(4000);
    handlersBox.handlers?.update({ type: "agent_update" });
    await tick(300);
    expect(handle.send).not.toHaveBeenCalled();

    // Another run-stop cycle retries.
    handle.status = "running";
    handlersBox.handlers?.update({ type: "agent_update" });
    await tick(300);
    handle.status = "idle";
    handlersBox.handlers?.update({ type: "agent_update" });
    await tick(300);
    expect(handle.send).toHaveBeenCalledTimes(1);
  });

  it("nudge retries after a failed send", async () => {
    const { handle, paseo } = setup();
    const queue = await import("./queue");
    const drain = await import("./queue-drain");
    vi.spyOn(console, "warn").mockImplementation(function silent() {
      return undefined;
    });
    queue.enqueueMessage("s7", { text: "x", images: [] });
    drain.ensureQueueDrain(paseo as never);
    await tick(10);

    handle.send.mockRejectedValueOnce(new Error("down"));
    drain.nudgeQueueDrain("s7");
    await tick(10);
    expect(handle.send).toHaveBeenCalledTimes(1);
    expect(queue.queueFor("s7")).toHaveLength(1);

    drain.nudgeQueueDrain("s7");
    await tick(10);
    expect(handle.send).toHaveBeenCalledTimes(2);
    expect(queue.queueFor("s7")).toHaveLength(0);
  });

  it("drains queued images as bare {data, mimeType} pairs", async () => {
    const { handle, paseo } = setup();
    const queue = await import("./queue");
    const drain = await import("./queue-drain");
    const image = {
      id: "i1",
      mimeType: "image/png",
      data: "QUJD",
      uri: "data:image/png;base64,QUJD",
    };
    queue.enqueueMessage("s9", { text: "x", images: [image] });
    drain.ensureQueueDrain(paseo as never);
    await tick(10);

    drain.nudgeQueueDrain("s9");
    await tick(10);
    expect(handle.send).toHaveBeenCalledWith("x", {
      activeTurnBehavior: "steer",
      images: [{ data: "QUJD", mimeType: "image/png" }],
    });
  });

  it("a run shorter than the debounce window still drains the next message", async () => {
    const { handle, paseo, handlersBox } = setup();
    const queue = await import("./queue");
    const drain = await import("./queue-drain");
    queue.enqueueMessage("s10", { text: "A", images: [] });
    queue.enqueueMessage("s10", { text: "B", images: [] });
    drain.markQueuedWhileRunning("s10");
    drain.ensureQueueDrain(paseo as never);
    await tick(10);

    handle.status = "idle";
    handlersBox.handlers?.update({ type: "agent_update" });
    await tick(300);
    expect(handle.send).toHaveBeenCalledTimes(1);
    expect(queue.queueFor("s10").map((m) => m.text)).toEqual(["B"]);

    // The A-turn started and finished inside one debounce window: the only
    // observation still reads "idle", but the successful send marked the
    // record running, so this idle drains B instead of stalling forever.
    handlersBox.handlers?.update({ type: "agent_update" });
    await tick(300);
    expect(handle.send).toHaveBeenCalledTimes(2);
    expect(handle.send).toHaveBeenLastCalledWith("B", { activeTurnBehavior: "steer" });
    expect(queue.queueFor("s10")).toHaveLength(0);
  });

  it("never sends to an archived agent and drops its queue", async () => {
    const { handle, paseo, handlersBox } = setup();
    const queue = await import("./queue");
    const drain = await import("./queue-drain");
    queue.enqueueMessage("s11", { text: "一", images: [] });
    queue.enqueueMessage("s11", { text: "二", images: [] });
    drain.ensureQueueDrain(paseo as never);
    await tick(10);

    // User archives the agent while it runs: daemon stops the turn and sets
    // archivedAt. The resulting "stopped" observation must not send.
    handle.status = "running";
    handlersBox.handlers?.update({ type: "agent_update" });
    await tick(300);
    handle.status = "closed";
    handle.archivedAt = "2026-10-13T00:00:00Z";
    handlersBox.handlers?.update({ type: "agent_update" });
    await tick(300);
    expect(handle.send).not.toHaveBeenCalled();
    expect(queue.queueFor("s11")).toHaveLength(0);
  });

  it("a nudge on an archived session drops the queue without sending", async () => {
    const { handle, paseo } = setup();
    const queue = await import("./queue");
    const drain = await import("./queue-drain");
    queue.enqueueMessage("s12", { text: "x", images: [] });
    drain.ensureQueueDrain(paseo as never);
    await tick(10);

    handle.archivedAt = "2026-10-13T00:00:00Z";
    drain.nudgeQueueDrain("s12");
    await tick(10);
    expect(handle.send).not.toHaveBeenCalled();
    expect(queue.queueFor("s12")).toHaveLength(0);
  });

  it("releases the observation once every queue is empty", async () => {
    const { handle, paseo } = setup();
    const queue = await import("./queue");
    const drain = await import("./queue-drain");
    queue.enqueueMessage("s8", { text: "x", images: [] });
    drain.ensureQueueDrain(paseo as never);
    await tick(10);
    expect(paseo.agents.list).toHaveBeenCalledTimes(1);

    drain.nudgeQueueDrain("s8");
    await tick(10);
    expect(queue.queueFor("s8")).toHaveLength(0);
    // New enqueue reopens the observation.
    queue.enqueueMessage("s8", { text: "y", images: [] });
    drain.ensureQueueDrain(paseo as never);
    await tick(10);
    expect(paseo.agents.list).toHaveBeenCalledTimes(2);
    queue.takeQueuedMessage("s8", queue.queueFor("s8")[0].id);
  });
});
