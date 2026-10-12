import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ANALYZER_SETTINGS, type AnalyzerSettings } from "../shared/settings";
import type { Analysis } from "../shared/types";
import type { Analyzer } from "./analyzer/analyzer";
import type { AnalyzerInput } from "./analyzer/prompt";
import type {
  ArchivedEvent,
  ClosedEvent,
  PaseoApi,
  TurnEndedEvent,
  TurnStartedEvent,
} from "./host-types";
import { newRecord } from "./lifecycle";
import { SessionManagerService } from "./service";
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
) {
  let current: AnalyzerSettings = { ...DEFAULT_ANALYZER_SETTINGS, ...settings };
  const service = new SessionManagerService({
    store: store ?? memoryStore(),
    analyzer,
    settings: { current: () => current, refresh: async () => current },
    checkAnalyzer: async () => null,
    writeTitle: vi.fn(async () => undefined),
    ...(now ? { now } : {}),
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
      const paseo = {
        agents: {
          list: vi.fn(async () => ({
            entries,
            pageInfo: { hasMore: false, nextCursor: null },
          })),
          ref: (id: string) => ({
            refresh: async () => null,
            timeline: {
              refetch: (options: { limit?: number }) => {
                calls.push({ id, options });
                return refetch(id);
              },
            },
          }),
        },
      } as unknown as PaseoApi;
      return { paseo, calls };
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
});
