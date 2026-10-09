import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ANALYZER_SETTINGS, type AnalyzerSettings } from "../shared/settings";
import type { Analysis } from "../shared/types";
import type { Analyzer } from "./analyzer/analyzer";
import type { AnalyzerInput } from "./analyzer/prompt";
import type { ArchivedEvent, ClosedEvent, TurnEndedEvent } from "./host-types";
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

function make(settings: Partial<AnalyzerSettings> = {}, analyzer?: Analyzer, store?: StateStore) {
  let current: AnalyzerSettings = { ...DEFAULT_ANALYZER_SETTINGS, ...settings };
  const service = new SessionManagerService({
    store: store ?? memoryStore(),
    analyzer,
    settings: { current: () => current, refresh: async () => current },
    checkAnalyzer: async () => null,
    writeTitle: vi.fn(async () => undefined),
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
});
