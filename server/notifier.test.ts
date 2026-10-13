import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SPEECH_SETTINGS, type SpeechSettings } from "../shared/speech";
import type { Analysis } from "../shared/types";
import { AnnouncementFeed } from "./announcements";
import { TimelineCardPublisher, permissionRowId, turnRowId } from "./cards";
import type { PaseoApi } from "./host-types";
import { CardNotifier, announcementKindFor, permissionAnnouncementKind } from "./notifier";

const analysis = (patch: Partial<Analysis> = {}): Analysis => ({
  title: "登录页",
  summary: "摘要。",
  speech: "登录页：已完成。",
  goal: "g",
  status: "completed",
  progress: [],
  completed: [],
  nextSteps: [],
  blockers: [],
  needsUserAttention: false,
  confidence: 1,
  ...patch,
});

function fakePaseo(append = vi.fn(async (_item: unknown) => ({ seq: 1, epoch: "e" }))) {
  const ref = vi.fn(() => ({ timeline: { append } }));
  return { paseo: { agents: { ref } } as unknown as PaseoApi, append, ref };
}

function make(patch: Partial<SpeechSettings> = {}) {
  const feed = new AnnouncementFeed(100, () => 1, 1);
  const notifier = new CardNotifier({
    publisher: new TimelineCardPublisher(),
    feed,
    speechSettings: () => ({ ...DEFAULT_SPEECH_SETTINGS, ...patch }),
  });
  return { notifier, feed };
}

const agent = { id: "a1", parentAgentId: null, name: "登录页" };

describe("announcement kinds", () => {
  it("maps outcome and status", () => {
    expect(announcementKindFor(analysis(), "completed")).toBe("finished");
    expect(announcementKindFor(analysis({ status: "waiting_for_user" }), "completed")).toBe("waiting");
    expect(announcementKindFor(analysis({ status: "blocked" }), "completed")).toBe("waiting");
    expect(announcementKindFor(analysis({ needsUserAttention: true }), "completed")).toBe("waiting");
    expect(announcementKindFor(analysis(), "failed")).toBe("error");
    expect(announcementKindFor(analysis(), "completed", { kind: "blocked", text: "x" })).toBe("waiting");
    expect(
      announcementKindFor(analysis({ needsUserAttention: true }), "completed", { kind: "done", text: "x" }),
    ).toBe("finished");
    expect(announcementKindFor(analysis(), "failed", { kind: "done", text: "x" })).toBe("error");
    expect(permissionAnnouncementKind({ id: "r", kind: "question" })).toBe("waiting");
    expect(permissionAnnouncementKind({ id: "r", kind: "tool" })).toBe("permission");
  });
});

describe("TimelineCardPublisher", () => {
  it("appends a plugin row under the stable id", async () => {
    const { paseo, append, ref } = fakePaseo();
    const { notifier } = make();
    await notifier.turnPending(paseo, agent, "t1");
    expect(ref).toHaveBeenCalledWith("a1");
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "plugin", id: "session-manager:turn:t1", version: 1 }),
    );
    expect(turnRowId("t1")).toBe("session-manager:turn:t1");
    expect(permissionRowId("r1")).toBe("session-manager:perm:r1");
  });

  it("keeps a slow pending write ahead of the final one", async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const append = vi.fn(async (item: { data: { state: string } }) => {
      if (item.data.state === "pending") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      order.push(item.data.state);
      return { seq: 1, epoch: "e" };
    });
    const { paseo } = fakePaseo(append as never);
    const { notifier } = make();
    const pending = notifier.turnPending(paseo, agent, "t1");
    const ready = notifier.turnReady(paseo, agent, "t1", analysis(), "completed");
    await Promise.resolve();
    release();
    await Promise.all([pending, ready]);
    expect(order).toEqual(["pending", "ready"]);
  });

  it("never throws when the host rejects, and logs once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { paseo } = fakePaseo(vi.fn(async () => Promise.reject(new Error("no timeline.append"))) as never);
    const { notifier } = make();
    await expect(notifier.turnPending(paseo, agent, "t1")).resolves.toBeUndefined();
    await notifier.turnFailed(paseo, agent, "t1", "x");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("CardNotifier cards and announcements", () => {
  it("publishes ready/failed/superseded states", async () => {
    const { paseo, append } = fakePaseo();
    const { notifier } = make();
    await notifier.turnReady(paseo, agent, "t1", analysis(), "completed");
    await notifier.turnFailed(paseo, agent, "t2", "超时");
    await notifier.turnSuperseded(paseo, agent, "t3");
    const states = append.mock.calls.map((call) => (call[0] as { data: { state: string } }).data.state);
    expect(states).toEqual(["ready", "failed", "superseded"]);
  });

  it("announces a ready analysis with its speech sentence", async () => {
    const { paseo } = fakePaseo();
    const { notifier, feed } = make();
    await notifier.turnReady(paseo, agent, "t1", analysis(), "completed");
    expect(feed.since(0).events).toMatchObject([{ agentId: "a1", kind: "finished", text: "登录页：已完成。" }]);
  });

  it("does not announce disabled kinds, sub-agents, or when switched off, but still cards", async () => {
    const { paseo, append } = fakePaseo();
    const off = make({ announceFinished: false });
    await off.notifier.turnReady(paseo, agent, "t1", analysis(), "completed");
    expect(off.feed.since(0).events).toHaveLength(0);
    const sub = make();
    await sub.notifier.turnReady(paseo, { ...agent, parentAgentId: "p" }, "t1", analysis(), "completed");
    expect(sub.feed.since(0).events).toHaveLength(0);
    const master = make({ enabled: false });
    await master.notifier.turnReady(paseo, agent, "t1", analysis(), "completed");
    expect(master.feed.since(0).events).toHaveLength(0);
    expect(append).toHaveBeenCalledTimes(3);
  });

  it("appends a permission card, announces it, and rewrites it when resolved", async () => {
    const { paseo, append } = fakePaseo();
    const { notifier, feed } = make();
    await notifier.permissionRequested(paseo, agent, { id: "r1", kind: "tool", title: "运行 npm test" });
    expect(feed.since(0).events).toMatchObject([{ kind: "permission", text: "登录页：等待授权：运行 npm test" }]);
    await notifier.permissionResolved(paseo, agent, "r1", "allow");
    const rows = append.mock.calls.map((call) => call[0] as { id: string; data: { label: string } });
    expect(rows.map((row) => row.id)).toEqual(["session-manager:perm:r1", "session-manager:perm:r1"]);
    expect(rows.map((row) => row.data.label)).toEqual(["等待授权", "已允许"]);
    // Unknown request ids (daemon restarted in between) are ignored.
    await notifier.permissionResolved(paseo, agent, "other", "deny");
    expect(append).toHaveBeenCalledTimes(2);
  });

  it("treats a question as 需要处理 for gating", async () => {
    const { paseo } = fakePaseo();
    const { notifier, feed } = make({ announceWaiting: false });
    await notifier.permissionRequested(paseo, agent, { id: "q", kind: "question", title: "选哪个？" });
    expect(feed.since(0).events).toHaveLength(0);
  });
});
