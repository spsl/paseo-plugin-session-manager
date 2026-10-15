import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ANALYZER_SETTINGS, type AnalyzerSettings } from "../shared/settings";
import type { Analysis, Turn } from "../shared/types";
import type { Analyzer } from "./analyzer/analyzer";
import type { AnalyzerInput } from "./analyzer/prompt";
import { openDigestStore, type DigestStore } from "./digest-store";
import type {
  ArchivedEvent,
  ClosedEvent,
  PaseoApi,
  TurnEndedEvent,
  TurnStartedEvent,
} from "./host-types";
import { newRecord } from "./lifecycle";
import { SessionManagerService, type ServiceDeps } from "./service";
import type { SessionRecord, StateStore } from "./store";

const agent = (id = "a1") => ({
  id,
  workspaceId: null,
  parentAgentId: null,
  provider: "codex",
  cwd: "/w",
  title: null,
});

function turnEnded(
  turnId: string | null,
  reply: string,
  id = "a1",
  user = "做事",
): TurnEndedEvent {
  return {
    agent: agent(id),
    turnId,
    outcome: { kind: "completed" },
    timeline: [
      { type: "user_message", text: user },
      { type: "assistant_message", text: reply },
    ],
  } as unknown as TurnEndedEvent;
}

function analysis(title = "标题"): Analysis {
  return {
    title,
    summary: "s",
    goal: "g",
    status: "completed",
    progress: [],
    completed: [],
    nextSteps: [],
    blockers: [],
    needsUserAttention: false,
    confidence: 0.9,
  };
}

type Call = { input: AnalyzerInput; resolve: (value: Analysis) => void; reject: (error: Error) => void };

function fakeAnalyzer(auto = false) {
  const calls: Call[] = [];
  const analyzer: Analyzer = {
    analyze(input) {
      return new Promise<Analysis>((resolve, reject) => {
        if (auto) {
          resolve(analysis());
          calls.push({ input, resolve, reject });
          return;
        }
        calls.push({ input, resolve, reject });
      });
    },
  };
  return { analyzer, calls };
}

function memoryStore(initial: SessionRecord[] = []): StateStore & { saved: number } {
  const store = {
    saved: 0,
    load: async () => initial,
    schedule: () => {
      store.saved += 1;
    },
    flush: async () => undefined,
  };
  return store;
}

function make(
  settings: Partial<AnalyzerSettings> = {},
  analyzer?: Analyzer,
  store?: StateStore,
  now?: () => number,
  extras: Partial<ServiceDeps> = {},
) {
  let current: AnalyzerSettings = { ...DEFAULT_ANALYZER_SETTINGS, ...settings };
  const service = new SessionManagerService({
    store: store ?? memoryStore(),
    analyzer,
    settings: { current: () => current, refresh: async () => current },
    checkAnalyzer: async () => null,
    writeTitle: vi.fn(async () => undefined),
    ...(now ? { now } : {}),
    ...extras,
  });
  return { service, setSettings: (next: Partial<AnalyzerSettings>) => (current = { ...current, ...next }) };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("SessionManagerService", () => {
  it("enqueues an analysis on turn_ended and stores the result", async () => {
    const { analyzer, calls } = fakeAnalyzer();
    const { service } = make({}, analyzer);
    service.onTurnEnded(turnEnded("t1", "完成了"));
    await tick();
    expect(calls).toHaveLength(1);
    expect(calls[0].input.turns.at(-1)?.agentOutput).toBe("完成了");
    expect(service.getRecord("a1")?.analysisState).toBe("running");
    calls[0].resolve(analysis());
    await service.waitForIdle();
    const record = service.getRecord("a1");
    expect(record?.analysisState).toBe("ready");
    expect(record?.analysis?.title).toBe("标题");
    expect(record?.analyzedTurnId).toBe("t1");
    expect(record?.firstUserMessage).toBe("做事");
  });

  it("does not double-enqueue a repeated turn id or identical content", async () => {
    const { analyzer, calls } = fakeAnalyzer(true);
    const { service } = make({}, analyzer);
    service.onTurnEnded(turnEnded("t1", "完成了"));
    await service.waitForIdle();
    service.onTurnEnded(turnEnded("t1", "完成了"));
    service.onTurnEnded(turnEnded("t2", "完成了"));
    await service.waitForIdle();
    expect(calls).toHaveLength(1);
    expect(service.getRecord("a1")?.turns).toHaveLength(1);
  });

  it("updates a repeated turn id in place and re-analyzes when content changed", async () => {
    const { analyzer, calls } = fakeAnalyzer(true);
    const { service } = make({}, analyzer);
    service.onTurnEnded(turnEnded("t1", "第一版"));
    await service.waitForIdle();
    service.onTurnEnded(turnEnded("t1", "第二版"));
    await service.waitForIdle();
    expect(calls).toHaveLength(2);
    expect(service.getRecord("a1")?.turns).toHaveLength(1);
    expect(service.getRecord("a1")?.turns[0].agentOutput).toBe("第二版");
  });

  it("drops a stale result when a newer turn arrives and then analyzes the newer turn", async () => {
    const { analyzer, calls } = fakeAnalyzer();
    const { service } = make({}, analyzer);
    service.onTurnEnded(turnEnded("t1", "一"));
    await tick();
    service.onTurnEnded(turnEnded("t2", "二"));
    calls[0].resolve(analysis("过期"));
    await tick();
    expect(service.getRecord("a1")?.analysis).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1].input.turns.at(-1)?.id).toBe("t2");
    calls[1].resolve(analysis("最新"));
    await service.waitForIdle();
    expect(service.getRecord("a1")?.analysis?.title).toBe("最新");
  });

  it("accumulates 之前 items per turn and replaces a turn's items on reanalysis", async () => {
    const { analyzer, calls } = fakeAnalyzer();
    const { service } = make({}, analyzer);
    service.onTurnEnded(turnEnded("t1", "一", "a1", "第一件"));
    await tick();
    expect(calls[0].input.historyTurnId).toBeNull();
    calls[0].resolve({ ...analysis(), done: ["做完一"] });
    await service.waitForIdle();

    service.onTurnEnded(turnEnded("t2", "二", "a1", "第二件"));
    await tick();
    expect(calls[1].input.history).toEqual(["做完一"]);
    expect(calls[1].input.historyTurnId).toBe("t1");
    calls[1].resolve({ ...analysis(), done: ["做完二"] });
    await service.waitForIdle();
    expect(service.getRecord("a1")?.history.map((entry) => entry.text)).toEqual(["做完一", "做完二"]);

    expect(service.reanalyze("a1").ok).toBe(true);
    await tick();
    // Same boundary as t2's first run, without t2's own items.
    expect(calls[2].input.historyTurnId).toBe("t1");
    expect(calls[2].input.history).toEqual(["做完一"]);
    calls[2].resolve({ ...analysis(), done: ["重做二"] });
    await service.waitForIdle();
    expect(service.detail("a1")?.history.map((entry) => entry.text)).toEqual(["做完一", "重做二"]);
  });

  it("keeps the history when an analysis carries no done field", async () => {
    const { analyzer, calls } = fakeAnalyzer();
    const { service } = make({}, analyzer);
    service.onTurnEnded(turnEnded("t1", "一"));
    await tick();
    calls[0].resolve({ ...analysis(), done: ["做完一"] });
    await service.waitForIdle();
    service.reanalyze("a1");
    await tick();
    calls[1].resolve(analysis());
    await service.waitForIdle();
    expect(service.getRecord("a1")?.history.map((entry) => entry.text)).toEqual(["做完一"]);
  });

  it("respects the concurrency limit", async () => {
    const { analyzer, calls } = fakeAnalyzer();
    const { service } = make({ concurrency: 2 }, analyzer);
    for (const id of ["a", "b", "c"]) {
      service.onTurnEnded(turnEnded("t", "x", id, `u-${id}`));
    }
    await tick();
    expect(calls).toHaveLength(2);
    calls[0].resolve(analysis());
    await tick();
    expect(calls).toHaveLength(3);
    calls[1].resolve(analysis());
    calls[2].resolve(analysis());
    await service.waitForIdle();
  });

  it("leaves records queued while disabled and drains after settings change", async () => {
    const { analyzer, calls } = fakeAnalyzer(true);
    const { service, setSettings } = make({ enabled: false }, analyzer);
    service.onTurnEnded(turnEnded("t1", "x"));
    await tick();
    expect(calls).toHaveLength(0);
    expect(service.getRecord("a1")?.analysisState).toBe("queued");
    setSettings({ enabled: true });
    service.settingsChanged();
    await service.waitForIdle();
    expect(service.getRecord("a1")?.analysisState).toBe("ready");
  });

  it("refuses reanalyze while running or without turns", async () => {
    const { analyzer, calls } = fakeAnalyzer();
    const { service } = make({}, analyzer);
    service.onCreated({ agent: agent() });
    expect(service.reanalyze("a1").ok).toBe(false);
    service.onTurnEnded(turnEnded("t1", "x"));
    await tick();
    expect(service.reanalyze("a1")).toEqual({ ok: false, reason: "正在分析中" });
    calls[0].resolve(analysis());
    await service.waitForIdle();
    expect(service.reanalyze("a1").ok).toBe(true);
    await tick();
    expect(calls).toHaveLength(2);
    calls[1].resolve(analysis());
    await service.waitForIdle();
    expect(service.reanalyze("missing").ok).toBe(false);
  });

  it("refuses manual status for closed sessions and supports clearing", () => {
    const { service } = make();
    service.onCreated({ agent: agent() });
    expect(service.setManualStatus("a1", "completed").ok).toBe(true);
    expect(service.getRecord("a1")?.manualStatusOverride).toBe("completed");
    expect(service.clearManualStatus("a1").ok).toBe(true);
    expect(service.getRecord("a1")?.manualStatusOverride).toBeNull();
    service.onClosed({ agent: agent() } as ClosedEvent);
    expect(service.setManualStatus("a1", "completed").ok).toBe(false);
  });

  it("defers and resumes a live session, refusing closed ones", async () => {
    const { service } = make();
    service.onCreated({ agent: agent() });
    const before = Date.now();
    expect(service.defer("a1", 3_600_000, true).ok).toBe(true);
    const record = service.getRecord("a1") as SessionRecord;
    expect(record.deferToQueue).toBe(true);
    expect(record.deferredUntil).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(record.deferredUntil).toBeLessThanOrEqual(Date.now() + 3_600_000);
    const view = (await service.snapshot()).sessions.find((s) => s.id === "a1");
    expect(view).toMatchObject({ column: "deferred", deferToQueue: true, needsAttention: false });

    expect(service.clearDefer("a1").ok).toBe(true);
    expect(record.deferredUntil).toBeNull();
    expect(record.deferToQueue).toBe(false);

    service.onClosed({ agent: agent() } as ClosedEvent);
    expect(service.defer("a1", 3_600_000, false).ok).toBe(false);
    expect(service.defer("missing", 3_600_000, false).ok).toBe(false);
  });

  it("keeps the defer across a close (restart survival) and clears it on archive", () => {
    const { service } = make();
    service.onCreated({ agent: agent("a1") });
    service.defer("a1", 3_600_000, true);
    service.onClosed({ agent: agent("a1") } as ClosedEvent);
    expect(service.getRecord("a1")?.deferredUntil).not.toBeNull();
    expect(service.getRecord("a1")?.deferToQueue).toBe(true);

    service.onCreated({ agent: agent("a2") });
    service.defer("a2", 3_600_000, true);
    service.onArchived({
      agent: agent("a2"),
      archivedAt: new Date().toISOString(),
    } as ArchivedEvent);
    expect(service.getRecord("a2")).toMatchObject({ deferredUntil: null, deferToQueue: false });
  });

  it("marks an expired defer on the view and clears it once the card is opened", async () => {
    const { service } = make();
    service.onCreated({ agent: agent() });
    service.defer("a1", 60_000, true);
    const record = service.getRecord("a1") as SessionRecord;
    record.deferredUntil = Date.now() - 1;

    const before = (await service.snapshot()).sessions.find((s) => s.id === "a1");
    expect(before).toMatchObject({ deferEndedAt: record.deferredUntil, column: "unclear" });

    const detail = service.detail("a1");
    expect(detail?.deferEndedAt).not.toBeNull();
    expect(record.deferredUntil).toBeNull();
    expect(record.deferToQueue).toBe(false);

    const after = service.detail("a1");
    expect(after?.deferEndedAt).toBeNull();
  });

  it("keeps an active defer when the card is opened", () => {
    const { service } = make();
    service.onCreated({ agent: agent() });
    service.defer("a1", 3_600_000, true);
    const detail = service.detail("a1");
    expect(detail?.deferEndedAt).toBeNull();
    expect(service.getRecord("a1")?.deferredUntil).not.toBeNull();
  });

  it("drops the result when the agent is archived during a run", async () => {
    const { analyzer, calls } = fakeAnalyzer();
    const { service } = make({}, analyzer);
    service.onTurnEnded(turnEnded("t1", "x"));
    await tick();
    service.onArchived({ agent: agent(), archivedAt: new Date().toISOString() } as ArchivedEvent);
    calls[0].resolve(analysis());
    await service.waitForIdle();
    const record = service.getRecord("a1");
    expect(record?.analysis).toBeNull();
    expect(record?.analysisState).toBe("awaiting_output");
    expect(record?.liveness).toBe("archived");
  });

  it("records a failed analysis and keeps the error", async () => {
    const { analyzer, calls } = fakeAnalyzer();
    const { service } = make({}, analyzer);
    service.onTurnEnded(turnEnded("t1", "x"));
    await tick();
    calls[0].reject(new Error("分析超时"));
    await service.waitForIdle();
    expect(service.getRecord("a1")).toMatchObject({ analysisState: "failed", analysisError: "分析超时" });
  });

  it("re-queues restored queued records and forgets only closed ones", async () => {
    const first = make({ enabled: false }, fakeAnalyzer(true).analyzer);
    first.service.onTurnEnded(turnEnded("t1", "x"));
    const saved = first.service.getRecord("a1") as SessionRecord;
    saved.analysisState = "queued";
    const { analyzer, calls } = fakeAnalyzer(true);
    const second = make({}, analyzer, memoryStore([saved]));
    expect(await second.service.load()).toBe(1);
    await second.service.waitForIdle();
    expect(calls).toHaveLength(1);
    expect(second.service.forget("a1").ok).toBe(false);
    second.service.onClosed({ agent: agent() } as ClosedEvent);
    expect(second.service.forget("a1").ok).toBe(true);
    expect(second.service.getRecord("a1")).toBeUndefined();
  });

  it("builds snapshot views and filters old closed sessions", async () => {
    const { service } = make({ closedRetentionDays: 1 }, fakeAnalyzer(true).analyzer);
    service.onCreated({ agent: agent("live") });
    service.onCreated({ agent: agent("old") });
    service.onClosed({ agent: agent("old") } as ClosedEvent);
    (service.getRecord("old") as SessionRecord).updatedAt = Date.now() - 3 * 86_400_000;
    const result = await service.snapshot();
    expect(result.sessions.map((session) => session.id)).toEqual(["live"]);
    expect(result.analyzer.enabled).toBe(true);
  });

  it("writes titles back only when allowed", async () => {
    const writeTitle = vi.fn(async () => undefined);
    const { analyzer, calls } = fakeAnalyzer();
    const service = new SessionManagerService({
      store: memoryStore(),
      analyzer,
      settings: {
        current: () => ({ ...DEFAULT_ANALYZER_SETTINGS, writeBackTitle: true }),
        refresh: async () => DEFAULT_ANALYZER_SETTINGS,
      },
      checkAnalyzer: async () => null,
      writeTitle,
    });
    service.onTurnEnded(turnEnded("t1", "x"));
    await tick();
    calls[0].resolve(analysis("生成标题"));
    await service.waitForIdle();
    await tick();
    expect(writeTitle).toHaveBeenCalledWith("a1", "生成标题");
    expect(service.getRecord("a1")?.titleState.lastWritten).toBe("生成标题");

    const renamed = service.getRecord("a1") as SessionRecord;
    renamed.agentTitle = "我的名字";
    await service.maybeWriteBackTitle("a1", "另一个标题");
    expect(writeTitle).toHaveBeenCalledTimes(1);
    expect(renamed.titleState.userOwned).toBe(true);

    expect((await service.applyGeneratedTitle("a1")).ok).toBe(true);
    expect(writeTitle).toHaveBeenCalledTimes(2);
    expect(renamed.titleState.userOwned).toBe(false);
  });
  describe("excluded helper agents", () => {
    const entry = (id: string, labels: Record<string, string>, parentAgentId: string | null = null) => ({
      agent: {
        id,
        provider: "claude",
        cwd: "/w",
        status: "idle",
        labels,
        parentAgentId,
        title: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      project: { projectKey: "p", projectName: "P", checkout: { currentBranch: "main" } },
    });

    function fakePaseo(labelsById: Record<string, Record<string, string>>, entries: unknown[] = []) {
      const refresh = vi.fn(async (id: string) => {
        const labels = labelsById[id];
        return labels ? entry(id, labels) : null;
      });
      const paseo = {
        agents: {
          ref: (id: string) => ({ id, refresh: () => refresh(id) }),
          list: async () => ({ entries, pageInfo: { hasMore: false, nextCursor: null } }),
        },
      } as unknown as PaseoApi;
      return { paseo, refresh };
    }

    it("removes a hook-created agent found excluded via refresh and never analyzes it", async () => {
      const { analyzer, calls } = fakeAnalyzer(true);
      const { service } = make({}, analyzer);
      const { paseo, refresh } = fakePaseo({ h1: { "herald.role": "summarizer" } });
      service.touchPaseo(paseo);
      service.onCreated({ agent: agent("h1") });
      service.onTurnEnded(turnEnded("t1", "摘要", "h1"));
      await service.waitForIdle();
      await tick();
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(service.getRecord("h1")).toBeUndefined();
      expect(calls).toHaveLength(0);
    });

    it("keeps agents whose labels are not excluded, including sub-agents", async () => {
      const { analyzer, calls } = fakeAnalyzer(true);
      const { service } = make({}, analyzer);
      const { paseo } = fakePaseo({ s1: { team: "x" } });
      service.touchPaseo(paseo);
      service.onCreated({ agent: { ...agent("s1"), parentAgentId: "parent" } });
      service.onTurnEnded(turnEnded("t1", "完成", "s1"));
      await service.waitForIdle();
      expect(service.getRecord("s1")).toMatchObject({ labelsKnown: true });
      expect(calls).toHaveLength(1);
    });

    it("reconcile skips and removes excluded agents", async () => {
      const { service } = make();
      service.onCreated({ agent: agent("old") });
      const { paseo } = fakePaseo(
        {},
        [
          entry("old", { "herald.role": "summarizer" }),
          entry("new", { "herald.role": "summarizer" }),
          entry("sub", { other: "1" }, "parent"),
        ],
      );
      await service.reconcile(paseo);
      expect(service.getRecord("old")).toBeUndefined();
      expect(service.getRecord("new")).toBeUndefined();
      expect(service.getRecord("sub")).toBeDefined();
    });

    it("matches key=value rules and drops newly excluded known records on settings change", async () => {
      const { service, setSettings } = make({ excludedLabelKeys: "" });
      const { paseo } = fakePaseo({}, [entry("a", { kind: "helper" }), entry("b", { kind: "main" })]);
      await service.reconcile(paseo);
      expect(service.size()).toBe(2);
      setSettings({ excludedLabelKeys: "kind=helper" });
      service.settingsChanged();
      expect(service.getRecord("a")).toBeUndefined();
      expect(service.getRecord("b")).toBeDefined();
      expect((await service.snapshot()).sessions.map((session) => session.id)).toEqual(["b"]);
    });
  });

  describe("restart recovery", () => {
    const closedEvent = (id: string) => ({ agent: agent(id) } as unknown as ClosedEvent);
    const turnStart = (id: string) => ({ agent: agent(id) } as unknown as TurnStartedEvent);

    function dormantRecord(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
      return {
        ...newRecord({ id, provider: "codex", cwd: "/w" }, 1),
        liveness: "dormant",
        ...overrides,
      };
    }

    function listEntry(id: string, status: string) {
      return {
        agent: {
          id,
          provider: "codex",
          cwd: "/w",
          status,
          title: null,
          labels: null,
          parentAgentId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        project: null,
      };
    }

    type RefetchCall = { id: string; options: { limit?: number } };
    type RefetchResult = { agent: unknown; entries: unknown[]; hasOlder: boolean };

    function fakeDaemon(entries: unknown[], refetch: (id: string) => Promise<RefetchResult>) {
      const calls: RefetchCall[] = [];
      const sends: Array<{ id: string; text: string }> = [];
      const paseo = {
        agents: {
          list: vi.fn(async () => ({
            entries,
            pageInfo: { hasMore: false, nextCursor: null },
          })),
          ref: (id: string) => ({
            refresh: async () => null,
            send: async (text: string) => {
              sends.push({ id, text });
            },
            timeline: {
              refetch: (options: { limit?: number }) => {
                calls.push({ id, options });
                return refetch(id);
              },
            },
          }),
        },
      } as unknown as PaseoApi;
      return { paseo, calls, sends };
    }

    const idleResult = (id: string): RefetchResult => ({
      agent: listEntry(id, "idle").agent,
      entries: [],
      hasOlder: false,
    });

    it("marks agents closed inside the shutdown window dormant, flagging interruptions", () => {
      const { service } = make();
      service.onCreated({ agent: agent("busy") });
      service.onTurnStarted(turnStart("busy"));
      service.onCreated({ agent: agent("calm") });
      service.onClosed(closedEvent("busy"));
      service.onClosed(closedEvent("calm"));
      expect(service.getRecord("busy")?.liveness).toBe("closed");
      service.prepareShutdown();
      const busy = service.getRecord("busy");
      expect(busy).toMatchObject({ liveness: "dormant" });
      expect(busy?.interruptedAt).not.toBeNull();
      expect(service.getRecord("calm")).toMatchObject({ liveness: "dormant", interruptedAt: null });
    });

    it("keeps closures outside the shutdown window closed", () => {
      let now = 1_000_000;
      const { service } = make({}, undefined, undefined, () => now);
      service.onCreated({ agent: agent("a1") });
      service.onClosed(closedEvent("a1"));
      now += 31_000;
      service.prepareShutdown();
      expect(service.getRecord("a1")?.liveness).toBe("closed");
    });

    it("does not resurrect sessions that were already closed before shutdown", () => {
      let now = 1_000_000;
      const { service } = make({}, undefined, undefined, () => now);
      service.onCreated({ agent: agent("a1") });
      service.onClosed(closedEvent("a1")); // user close
      now += 40_000;
      service.onClosed(closedEvent("a1")); // daemon shutdown close
      service.prepareShutdown();
      expect(service.getRecord("a1")?.liveness).toBe("closed");
    });

    it("first reconcile after a restart turns persisted live-but-closed records dormant", async () => {
      const persisted = dormantRecord("a1", { liveness: "live", lifecycle: "working" });
      const { service } = make({}, undefined, memoryStore([persisted]));
      await service.load();
      const { paseo } = fakeDaemon([listEntry("a1", "closed")], async () => idleResult("a1"));
      await service.reconcile(paseo);
      const record = service.getRecord("a1");
      expect(record?.liveness).toBe("dormant");
      expect(record?.interruptedAt).not.toBeNull();
    });

    it("a reconcile racing the startup load waits for it instead of shadowing persisted records", async () => {
      let release: (records: SessionRecord[]) => void = () => undefined;
      const slowStore: StateStore = {
        load: () =>
          new Promise<SessionRecord[]>((resolve) => {
            release = resolve;
          }),
        schedule: () => undefined,
        flush: async () => undefined,
      };
      const { service } = make({}, undefined, slowStore);
      const loaded = service.load();
      const { paseo } = fakeDaemon([listEntry("a1", "closed")], async () => idleResult("a1"));
      const reconciled = service.reconcile(paseo);
      await tick();
      release([dormantRecord("a1", { analysis: null, interruptedAt: 7 })]);
      await Promise.all([loaded, reconciled]);
      expect(service.getRecord("a1")).toMatchObject({ liveness: "dormant", interruptedAt: 7 });
    });

    it("later reconciles still treat a live→closed transition as a real close", async () => {
      const persisted = dormantRecord("a1", { liveness: "live" });
      const { service } = make({}, undefined, memoryStore([persisted]));
      await service.load();
      const first = fakeDaemon([listEntry("a1", "idle")], async () => idleResult("a1"));
      await service.reconcile(first.paseo);
      expect(service.getRecord("a1")?.liveness).toBe("live");
      const second = fakeDaemon([listEntry("a1", "closed")], async () => idleResult("a1"));
      await service.reconcile(second.paseo);
      expect(service.getRecord("a1")?.liveness).toBe("closed");
    });

    it("keeps dormant records dormant across repeated restarts and closed reports", async () => {
      const { service } = make({}, undefined, memoryStore([dormantRecord("a1")]));
      await service.load();
      for (let round = 0; round < 3; round += 1) {
        const { paseo } = fakeDaemon([listEntry("a1", "closed")], async () => idleResult("a1"));
        await service.reconcile(paseo);
        expect(service.getRecord("a1")?.liveness).toBe("dormant");
      }
    });

    it("a new turn clears the interruption and resume state", () => {
      const { service } = make();
      service.onCreated({ agent: agent("a1") });
      service.onTurnStarted(turnStart("a1"));
      service.onClosed(closedEvent("a1"));
      service.prepareShutdown();
      expect(service.getRecord("a1")?.interruptedAt).not.toBeNull();
      service.getRecord("a1")!.resumeState = "failed";
      service.onTurnStarted(turnStart("a1"));
      expect(service.getRecord("a1")).toMatchObject({
        liveness: "live",
        interruptedAt: null,
        resumeState: "idle",
        resumeError: null,
      });
    });

    it("dismiss_resume closes a dormant session and clears interruption metadata", async () => {
      const { service } = make({}, undefined, memoryStore([dormantRecord("a1", { interruptedAt: 5 })]));
      await service.load();
      expect(service.dismissResume("a1")).toEqual({ ok: true });
      expect(service.getRecord("a1")).toMatchObject({
        liveness: "closed",
        interruptedAt: null,
        resumeState: "idle",
      });
      expect(service.dismissResume("a1").ok).toBe(false);
      expect(service.dismissResume("missing").ok).toBe(false);
    });

    it("resume refuses non-dormant sessions and deduplicates in-flight calls", async () => {
      const { service } = make({}, undefined, memoryStore([dormantRecord("a1")]));
      await service.load();
      expect(await service.resume("a1")).toEqual({ ok: false, reason: "尚未连接到 Paseo" });
      const { paseo, calls } = fakeDaemon([], async () => idleResult("a1"));
      service.touchPaseo(paseo);
      const one = service.resume("a1");
      const two = service.resume("a1");
      expect(await one).toEqual({ ok: true });
      expect(await two).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
      expect(service.getRecord("a1")?.liveness).toBe("live");
      expect(await service.resume("a1")).toEqual({ ok: false, reason: "会话未处于待恢复状态" });
    });

    it("a failed refetch records a Chinese reason without retrying", async () => {
      const { service } = make({}, undefined, memoryStore([dormantRecord("a1")]));
      await service.load();
      const { paseo, calls } = fakeDaemon([], async () => {
        throw new Error("连接被拒绝");
      });
      service.touchPaseo(paseo);
      const result = await service.resume("a1");
      expect(result.ok).toBe(false);
      expect(service.getRecord("a1")).toMatchObject({
        liveness: "dormant",
        resumeState: "failed",
        resumeError: "恢复失败：连接被拒绝",
      });
      expect(calls).toHaveLength(1);
    });

    it("records a timeout reason when the refetch never resolves", async () => {
      vi.useFakeTimers();
      try {
        const { service } = make({}, undefined, memoryStore([dormantRecord("a1")]));
        await service.load();
        const { paseo } = fakeDaemon([], () => new Promise<RefetchResult>(() => undefined));
        service.touchPaseo(paseo);
        const pending = service.resume("a1");
        await vi.advanceTimersByTimeAsync(61_000);
        const result = await pending;
        expect(result).toEqual({ ok: false, reason: "恢复超时（60 秒）" });
        expect(service.getRecord("a1")).toMatchObject({
          resumeState: "failed",
          resumeError: "恢复超时（60 秒）",
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("reopen refuses sessions that are not closed, and dormant goes through resume", async () => {
      const { service } = make({}, undefined, memoryStore([dormantRecord("d1")]));
      await service.load();
      service.onCreated({ agent: agent("live") });
      const { paseo, calls } = fakeDaemon([], async (id) => idleResult(id));
      service.touchPaseo(paseo);
      expect(await service.reopen("live")).toEqual({ ok: false, reason: "会话未关闭" });
      expect(await service.reopen("missing")).toEqual({ ok: false, reason: "会话不存在" });
      // Dormant sessions reopen through the regular resume path.
      expect(await service.reopen("d1")).toEqual({ ok: true });
      expect(service.getRecord("d1")?.liveness).toBe("live");
      expect(calls).toHaveLength(1);
    });

    it("reopen unarchives via the agent reload CLI, never the timeline refetch", async () => {
      const reload = vi.fn(async (id: string) => ({ ok: true as const, id }));
      const { service } = make(
        {},
        undefined,
        memoryStore([
          dormantRecord("a1", {
            liveness: "archived",
            archivedAt: 5,
            manualStatusOverride: "completed",
          }),
        ]),
        undefined,
        { reloadAgentCli: reload },
      );
      await service.load();
      // The reloaded agent reports idle; refresh returns null so reconcile resolves it.
      const { paseo, calls } = fakeDaemon([listEntry("a1", "idle")], async (id) => idleResult(id));
      service.touchPaseo(paseo);
      expect(await service.reopen("a1")).toEqual({ ok: true });
      expect(reload).toHaveBeenCalledWith("a1");
      expect(calls).toHaveLength(0);
      expect(service.getRecord("a1")).toMatchObject({
        liveness: "live",
        archivedAt: null,
        resumeState: "idle",
        manualStatusOverride: null,
      });
    });

    it("reopen reports a failed archived reload and stays archived", async () => {
      const { service } = make(
        {},
        undefined,
        memoryStore([dormantRecord("a1", { liveness: "archived", archivedAt: 5 })]),
        undefined,
        { reloadAgentCli: async () => ({ ok: false as const, reason: "重新打开超时" }) },
      );
      await service.load();
      const { paseo, calls } = fakeDaemon([], async (id) => idleResult(id));
      service.touchPaseo(paseo);
      expect(await service.reopen("a1")).toEqual({ ok: false, reason: "重新打开超时" });
      expect(calls).toHaveLength(0);
      expect(service.getRecord("a1")).toMatchObject({
        liveness: "archived",
        resumeState: "failed",
        resumeError: "重新打开超时",
      });
    });

    it("reopen brings a closed session back live and clears stale overrides", async () => {
      let now = 1_000_000;
      const { service } = make({}, undefined, undefined, () => now);
      service.onCreated({ agent: agent("a1") });
      service.setManualStatus("a1", "completed");
      service.defer("a1", 3_600_000, true);
      service.onClosed(closedEvent("a1"));
      const record = service.getRecord("a1") as SessionRecord;
      expect(record).toMatchObject({
        liveness: "closed",
        manualStatusOverride: "completed",
      });
      expect(record.deferredUntil).not.toBeNull();

      now += 60_000;
      const { paseo, calls } = fakeDaemon([], async (id) => idleResult(id));
      service.touchPaseo(paseo);
      expect(await service.reopen("a1")).toEqual({ ok: true });
      expect(calls).toHaveLength(1);
      expect(record).toMatchObject({
        liveness: "live",
        resumeState: "idle",
        resumeError: null,
        manualStatusOverride: null,
        deferredUntil: null,
        deferToQueue: false,
        updatedAt: now,
      });
    });

    it("reopen deduplicates in-flight calls and reports a failed refetch", async () => {
      const { service } = make();
      service.onCreated({ agent: agent("a1") });
      service.onClosed(closedEvent("a1"));
      expect(await service.reopen("a1")).toEqual({ ok: false, reason: "尚未连接到 Paseo" });
      const { paseo, calls } = fakeDaemon([], async () => {
        throw new Error("连接被拒绝");
      });
      service.touchPaseo(paseo);
      const one = service.reopen("a1");
      const two = service.reopen("a1");
      expect(await one).toEqual({ ok: false, reason: "重新打开失败：连接被拒绝" });
      expect(await two).toEqual({ ok: false, reason: "重新打开失败：连接被拒绝" });
      expect(calls).toHaveLength(1);
      expect(service.getRecord("a1")).toMatchObject({
        liveness: "closed",
        resumeState: "failed",
        resumeError: "重新打开失败：连接被拒绝",
      });
    });

    it("reopen fails when Paseo still reports the session closed", async () => {
      const { service } = make();
      service.onCreated({ agent: agent("a1") });
      service.onClosed(closedEvent("a1"));
      const { paseo } = fakeDaemon([listEntry("a1", "closed")], async () => ({
        agent: null,
        entries: [],
        hasOlder: false,
      }));
      service.touchPaseo(paseo);
      const result = await service.reopen("a1");
      expect(result.ok).toBe(false);
      expect(service.getRecord("a1")).toMatchObject({
        liveness: "closed",
        resumeState: "failed",
      });
    });

    it("auto-resume picks only attention columns under the default policy", async () => {
      const attention = (status: "waiting_for_user" | "in_progress" | "unclear") =>
        dormantRecord(`s-${status}`, {
          analysis: { ...analysis("x"), status },
        });
      const store = memoryStore([
        attention("waiting_for_user"),
        attention("in_progress"),
        attention("unclear"),
      ]);
      const { analyzer, calls: analyzerCalls } = fakeAnalyzer(true);
      const { service } = make({ autoResume: "attention" }, analyzer, store);
      await service.load();
      const { paseo, calls } = fakeDaemon(
        [listEntry("s-waiting_for_user", "closed"), listEntry("s-in_progress", "closed"), listEntry("s-unclear", "closed")],
        async (id) => idleResult(id),
      );
      service.touchPaseo(paseo);
      await service.snapshot();
      await service.waitForResume();
      const resumed = calls.filter((call) => call.options.limit === 1).map((call) => call.id);
      expect(resumed.sort()).toEqual(["s-in_progress", "s-waiting_for_user"]);
      expect(service.getRecord("s-unclear")?.liveness).toBe("dormant");
      expect(service.getRecord("s-waiting_for_user")?.liveness).toBe("live");
      // Resuming never schedules an analysis.
      expect(analyzerCalls).toHaveLength(0);
    });

    describe("team recovery", () => {
      const team = { team: "T1", role: "implementer" };
      const member = (overrides: Partial<SessionRecord> = {}) =>
        dormantRecord("m1", {
          parentAgentId: "coord",
          interruptedAt: 5,
          labels: team,
          labelsKnown: true,
          ...overrides,
        });
      const memberEntry = (status = "closed") => {
        const entry = listEntry("m1", status);
        return { ...entry, agent: { ...entry.agent, parentAgentId: "coord", labels: team } };
      };
      // Real snapshots carry the parent and labels; the generic idle result does not.
      const refetchIdle = async (id: string): Promise<RefetchResult> =>
        id === "m1" ? { ...idleResult(id), agent: memberEntry("idle").agent } : idleResult(id);

      it("resumes a dormant coordinator and tells it once which sub-agents were interrupted", async () => {
        const { service } = make({}, undefined, memoryStore([dormantRecord("coord"), member()]));
        await service.load();
        const { paseo, calls, sends } = fakeDaemon(
          [listEntry("coord", "closed"), memberEntry()],
          refetchIdle,
        );
        service.touchPaseo(paseo);
        await service.snapshot();
        await service.waitForResume();
        expect(calls.map((call) => call.id)).toContain("coord");
        expect(sends).toHaveLength(1);
        expect(sends[0].id).toBe("coord");
        expect(sends[0].text.split("\n")[0]).toBe("/dev-team 继续 T1");
        expect(sends[0].text).toContain("implementer（agentId m1）");
        expect(service.getRecord("m1")?.interruptNotifiedAt).toBe(5);

        // A plugin reload with the same restart does not report it again.
        const again = make(
          {},
          undefined,
          memoryStore([{ ...service.getRecord("coord")! }, { ...service.getRecord("m1")! }]),
        ).service;
        await again.load();
        const second = fakeDaemon([listEntry("coord", "idle"), memberEntry("idle")], refetchIdle);
        again.touchPaseo(second.paseo);
        await again.snapshot();
        await again.waitForResume();
        expect(second.sends).toHaveLength(0);
      });

      it("leaves the flow alone when disabled or the coordinator was closed", async () => {
        const off = make({ teamRecovery: "off" }, undefined, memoryStore([dormantRecord("coord"), member()]));
        await off.service.load();
        const offDaemon = fakeDaemon([listEntry("coord", "closed"), memberEntry()], refetchIdle);
        off.service.touchPaseo(offDaemon.paseo);
        await off.service.snapshot();
        await off.service.waitForResume();
        expect(offDaemon.sends).toHaveLength(0);

        const closed = make(
          {},
          undefined,
          memoryStore([dormantRecord("coord", { liveness: "closed" }), member()]),
        );
        await closed.service.load();
        const closedDaemon = fakeDaemon([listEntry("coord", "closed"), memberEntry()], refetchIdle);
        closed.service.touchPaseo(closedDaemon.paseo);
        await closed.service.snapshot();
        await closed.service.waitForResume();
        expect(closedDaemon.sends).toHaveLength(0);
        expect(closed.service.getRecord("m1")?.interruptNotifiedAt).toBeNull();
      });
    });

    it("auto-resume off leaves dormant sessions alone", async () => {
      const { service } = make(
        { autoResume: "off" },
        undefined,
        memoryStore([dormantRecord("a1")]),
      );
      await service.load();
      const { paseo, calls } = fakeDaemon([listEntry("a1", "closed")], async (id) => idleResult(id));
      service.touchPaseo(paseo);
      await service.snapshot();
      await service.waitForResume();
      expect(calls).toHaveLength(0);
      expect(service.getRecord("a1")?.liveness).toBe("dormant");
    });

    it("auto-resume all skips only sessions parked in the defer queue", async () => {
      const future = Date.now() + 3_600_000;
      const store = memoryStore([
        dormantRecord("queued-defer", { deferredUntil: future, deferToQueue: true }),
        dormantRecord("plain"),
        dormantRecord("masked-defer", { deferredUntil: future, deferToQueue: false }),
      ]);
      const { service } = make({ autoResume: "all" }, undefined, store);
      await service.load();
      const { paseo, calls } = fakeDaemon(
        [listEntry("queued-defer", "closed"), listEntry("plain", "closed"), listEntry("masked-defer", "closed")],
        async (id) => idleResult(id),
      );
      service.touchPaseo(paseo);
      await service.snapshot();
      await service.waitForResume();
      const resumed = calls.map((call) => call.id);
      expect(resumed.sort()).toEqual(["masked-defer", "plain"]);
      expect(service.getRecord("queued-defer")).toMatchObject({
        liveness: "dormant",
        deferredUntil: future,
      });
    });

    it("auto-resume never exceeds the concurrency limit", async () => {
      const ids = ["r1", "r2", "r3", "r4", "r5", "r6", "r7"];
      const store = memoryStore(ids.map((id) => dormantRecord(id)));
      const { service } = make({ autoResume: "all" }, undefined, store);
      await service.load();
      let inFlight = 0;
      let maxInFlight = 0;
      const resolvers: Array<() => void> = [];
      const { paseo } = fakeDaemon(
        ids.map((id) => listEntry(id, "closed")),
        (id) =>
          new Promise<RefetchResult>((resolve) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            resolvers.push(() => {
              inFlight -= 1;
              resolve(idleResult(id));
            });
          }),
      );
      service.touchPaseo(paseo);
      await service.snapshot();
      await tick();
      expect(inFlight).toBe(3);
      while (resolvers.length > 0) {
        const resolve = resolvers.shift();
        resolve?.();
        await tick();
      }
      await service.waitForResume();
      expect(maxInFlight).toBe(3);
      expect(ids.every((id) => service.getRecord(id)?.liveness === "live")).toBe(true);
    });

    it("auto-resume continues past failures and keeps failed sessions dormant", async () => {
      const store = memoryStore([dormantRecord("good"), dormantRecord("bad")]);
      const { service } = make({ autoResume: "all" }, undefined, store);
      await service.load();
      const { paseo } = fakeDaemon(
        [listEntry("good", "closed"), listEntry("bad", "closed")],
        async (id) => {
          if (id === "bad") {
            throw new Error("daemon 无响应");
          }
          return idleResult(id);
        },
      );
      service.touchPaseo(paseo);
      await service.snapshot();
      await service.waitForResume();
      expect(service.getRecord("good")?.liveness).toBe("live");
      expect(service.getRecord("bad")).toMatchObject({
        liveness: "dormant",
        resumeState: "failed",
        resumeError: "恢复失败：daemon 无响应",
      });
    });
  });

  describe("history.db", () => {
    let digests: DigestStore;
    beforeEach(async () => {
      const dir = await mkdtemp(join(tmpdir(), "sm-service-digests-"));
      digests = openDigestStore(join(dir, "history.db"));
    });
    afterEach(() => {
      digests.close();
    });

    const storedTurn = (id: string, output = "回复"): Turn => ({
      id,
      dedupeKey: `key-${id}-${output}`,
      userInput: `输入-${id}`,
      agentOutput: output,
      outcome: "completed",
      completedAt: 1_000,
      contextIncomplete: false,
      declared: null,
      editCount: 0,
      reviewVerdict: null,
    });

    it("upserts turns into history.db and feeds stored digests into the next analysis", async () => {
      const { analyzer, calls } = fakeAnalyzer();
      const { service } = make({}, analyzer, undefined, undefined, { digests });
      // Long reply → no raw digest; the model's digest is what lands.
      service.onTurnEnded(turnEnded("t1", "长".repeat(600)));
      await tick();
      calls[0].resolve({
        ...analysis(),
        turnDigests: [{ turnId: "t1", step: "第一轮步骤", digest: "第一轮摘要" }],
      });
      await service.waitForIdle();
      const rows = digests.listTurns("a1");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        turnId: "t1",
        step: "第一轮步骤",
        digest: "第一轮摘要",
        digestSource: "model",
      });

      service.onTurnEnded(turnEnded("t2", "第二轮回复"));
      await tick();
      // digests lists every row that has one — t2's own raw digest rides along;
      // the prompt builder excludes window ids later.
      const next = calls[1].input.digests ?? [];
      expect(next).toHaveLength(2);
      expect(next.find((entry) => entry.id === "t1")).toMatchObject({
        step: "第一轮步骤",
        digest: "第一轮摘要",
      });
      expect(next.find((entry) => entry.id === "t2")?.digest).toBe("第二轮回复");
      calls[1].resolve(analysis());
      await service.waitForIdle();
    });

    it("strips turnDigests from record.analysis and ignores non-new turn ids", async () => {
      const { analyzer, calls } = fakeAnalyzer();
      const { service } = make({}, analyzer, undefined, undefined, { digests });
      service.onTurnEnded(turnEnded("t1", "长".repeat(600)));
      await tick();
      calls[0].resolve({
        ...analysis(),
        turnDigests: [{ turnId: "t1", step: "步骤一", digest: "摘要一" }],
      });
      await service.waitForIdle();
      // turnDigests must not ride record.analysis — it's history.db-only data.
      expect(service.getRecord("a1")?.analysis?.turnDigests).toBeUndefined();

      // Different content — identical replies would be deduped and never analyzed.
      service.onTurnEnded(turnEnded("t2", "另".repeat(600)));
      await tick();
      // For this run t1 was isNew=false; the model still emitted a digest for it.
      calls[1].resolve({
        ...analysis(),
        turnDigests: [
          { turnId: "t1", step: "覆盖", digest: "覆盖" },
          { turnId: "t2", step: "步骤二", digest: "摘要二" },
        ],
      });
      await service.waitForIdle();
      const rows = digests.listTurns("a1");
      expect(rows.find((row) => row.turnId === "t1")).toMatchObject({
        step: "步骤一",
        digest: "摘要一",
      });
      expect(rows.find((row) => row.turnId === "t2")).toMatchObject({
        step: "步骤二",
        digest: "摘要二",
      });
    });

    it("rejects a write-back whose turn content changed mid-analysis", async () => {
      const { analyzer, calls } = fakeAnalyzer();
      const { service } = make({}, analyzer, undefined, undefined, { digests });
      service.onTurnEnded(turnEnded("t1", "旧内容"));
      await tick();
      // Same turnId ends again with new content: the row is reset, analysis #1
      // still resolves with digests describing the old content.
      service.onTurnEnded(turnEnded("t1", "新内容"));
      await tick();
      calls[0].resolve({
        ...analysis(),
        turnDigests: [{ turnId: "t1", step: "旧步骤", digest: "旧摘要" }],
      });
      await tick();
      const row = digests.listTurns("a1")[0];
      expect(row.step).toBeNull();
      expect(row.digest).toBe("新内容");
      expect(row.digestSource).toBe("raw");

      calls[1].resolve({
        ...analysis(),
        turnDigests: [{ turnId: "t1", step: "新步骤", digest: "新摘要" }],
      });
      await service.waitForIdle();
      // The fresh write lands its step; the digest stays raw (short reply).
      expect(digests.listTurns("a1")[0]).toMatchObject({
        step: "新步骤",
        digest: "新内容",
        digestSource: "raw",
      });
    });

    it("keeps a raw digest when the model writes one anyway, updating only the step", async () => {
      const { analyzer, calls } = fakeAnalyzer();
      const { service } = make({}, analyzer, undefined, undefined, { digests });
      service.onTurnEnded(turnEnded("t1", "短回复"));
      await tick();
      calls[0].resolve({
        ...analysis(),
        turnDigests: [{ turnId: "t1", step: "步骤", digest: "模型写的摘要" }],
      });
      await service.waitForIdle();
      const row = digests.listTurns("a1")[0];
      expect(row.digestSource).toBe("raw");
      expect(row.digest).toBe("短回复");
      expect(row.step).toBe("步骤");
    });

    it("keeps the boundary on the analyzed turn when an analysis returns no done items", async () => {
      const { analyzer, calls } = fakeAnalyzer();
      const { service } = make({}, analyzer, undefined, undefined, { digests });
      service.onTurnEnded(turnEnded("t1", "一"));
      await tick();
      calls[0].resolve({ ...analysis(), done: [] });
      await service.waitForIdle();
      service.onTurnEnded(turnEnded("t2", "二"));
      await tick();
      // analyzedTurnId=t1 stays the boundary even though nothing was recorded.
      expect(calls[1].input.historyTurnId).toBe("t1");
      calls[1].resolve(analysis());
      await service.waitForIdle();
    });

    it("removes a session's rows when the record is forgotten", async () => {
      const { analyzer, calls } = fakeAnalyzer();
      const { service } = make({}, analyzer, undefined, undefined, { digests });
      service.onTurnEnded(turnEnded("t1", "x"));
      await tick();
      calls[0].resolve(analysis());
      await service.waitForIdle();
      expect(digests.listTurns("a1")).toHaveLength(1);
      service.onClosed({ agent: agent() } as ClosedEvent);
      expect(service.forget("a1").ok).toBe(true);
      expect(digests.listTurns("a1")).toHaveLength(0);
    });

    it("prunes orphaned rows on load when records exist", async () => {
      digests.upsertTurn("keep", storedTurn("t1"), [], 1);
      digests.upsertTurn("gone", storedTurn("t2"), [], 2);
      const record = newRecord({ id: "keep", provider: "codex", cwd: "/w" }, 1);
      const { service } = make({}, undefined, memoryStore([record]), undefined, { digests });
      await service.load();
      expect(digests.listTurns("keep")).toHaveLength(1);
      expect(digests.listTurns("gone")).toHaveLength(0);
    });

    it("keeps every row when the state file reads back empty", async () => {
      digests.upsertTurn("s1", storedTurn("t1"), [], 1);
      digests.upsertTurn("s2", storedTurn("t2"), [], 2);
      const { service } = make({}, undefined, memoryStore([]), undefined, { digests });
      await service.load();
      expect(digests.listTurns("s1")).toHaveLength(1);
      expect(digests.listTurns("s2")).toHaveLength(1);
    });

    it("flow() merges stored digests with the 之前 fallback label", async () => {
      const { analyzer, calls } = fakeAnalyzer();
      const { service } = make({}, analyzer, undefined, undefined, { digests });
      service.onTurnEnded(turnEnded("t1", "长".repeat(600)));
      await tick();
      calls[0].resolve({
        ...analysis(),
        done: ["做完一"],
        turnDigests: [{ turnId: "t1", step: "步骤一", digest: "摘要一" }],
      });
      await service.waitForIdle();
      const result = service.flow("a1");
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.code).toContain("步骤一");
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0]).toMatchObject({
        turnId: "t1",
        step: "步骤一",
        historyLabel: "做完一",
        digest: "摘要一",
      });
      expect(service.flow("missing").ok).toBe(false);
    });

    it("logs every analyzer call — applied, failed, superseded, reanalyzed — newest first", async () => {
      let clock = 1_000;
      const { analyzer, calls } = fakeAnalyzer();
      const { service } = make({}, analyzer, undefined, () => clock, { digests });
      service.onTurnEnded(turnEnded("t1", "回复一", "a1", "第一个问题"));
      await tick();
      clock = 4_500;
      calls[0].resolve({ ...analysis(), confidence: 0.7 });
      await service.waitForIdle();

      service.onTurnEnded(turnEnded("t2", "回复二", "a1", "第二个问题"));
      await tick();
      calls[1].reject(new Error("分析超时"));
      await service.waitForIdle();

      // t4 ends while t3 is being analyzed: t3's result is never applied.
      service.onTurnEnded(turnEnded("t3", "回复三", "a1", "第三个问题"));
      await tick();
      service.onTurnEnded(turnEnded("t4", "回复四", "a1", "第四个问题"));
      await tick();
      calls[2].resolve(analysis());
      await tick();
      calls[3].resolve({ ...analysis(), confidence: 0.8 });
      await service.waitForIdle();

      expect(service.reanalyze("a1").ok).toBe(true);
      await tick();
      calls[4].resolve({ ...analysis(), confidence: 0.6 });
      await service.waitForIdle();

      const runs = service.detail("a1")?.analysisRuns ?? [];
      expect(
        runs.map((run) => [run.userInput, run.outcome, run.confidence, run.reanalysis]),
      ).toEqual([
        ["第四个问题", "applied", 0.6, true],
        ["第四个问题", "applied", 0.8, false],
        ["第三个问题", "superseded", 0.9, false],
        ["第二个问题", "failed", null, false],
        ["第一个问题", "applied", 0.7, false],
      ]);
      expect(runs[3].error).toContain("分析超时");
      expect(runs[4]).toMatchObject({ startedAt: 1_000, durationMs: 3_500, status: "completed" });

      const full = service.analysisRun("a1", runs[4].id);
      expect(full?.analysis?.confidence).toBe(0.7);
      expect(full?.newTurns).toBe(1);
      expect(full?.inputChars).toBeGreaterThan(0);
      expect(service.analysisRun("other", runs[4].id)).toBeNull();
    });
  });
});
