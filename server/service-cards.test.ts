import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ANALYZER_SETTINGS, type AnalyzerSettings } from "../shared/settings";
import type { Analysis } from "../shared/types";
import type { Analyzer } from "./analyzer/analyzer";
import type { AnalyzerInput } from "./analyzer/prompt";
import type { PaseoApi, PermissionRequestedEvent, PermissionResolvedEvent, TurnEndedEvent } from "./host-types";
import type { Notifier } from "./notifier";
import { SessionManagerService } from "./service";
import type { StateStore } from "./store";

const agent = (id = "a1", parentAgentId: string | null = null) => ({
  id,
  workspaceId: null,
  parentAgentId,
  provider: "codex",
  cwd: "/w/proj",
  title: "登录页",
});

function turnEnded(turnId: string, reply: string, id = "a1"): TurnEndedEvent {
  return {
    agent: agent(id),
    turnId,
    outcome: { kind: "completed" },
    timeline: [
      { type: "user_message", text: "做事" },
      { type: "assistant_message", text: reply },
    ],
  } as unknown as TurnEndedEvent;
}

const result = (): Analysis => ({
  title: "标题",
  summary: "s",
  speech: "标题：完成。",
  goal: "g",
  status: "completed",
  progress: [],
  completed: [],
  nextSteps: [],
  blockers: [],
  needsUserAttention: false,
  confidence: 1,
});

type Pending = { resolve: (value: Analysis) => void; reject: (error: Error) => void };

function harness(options: { labels?: Record<string, string>; settings?: Partial<AnalyzerSettings> } = {}) {
  const pending: Pending[] = [];
  const analyzer: Analyzer = {
    analyze(_input: AnalyzerInput) {
      return new Promise<Analysis>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
  };
  const calls: string[] = [];
  const notifier: Notifier = {
    turnPending: vi.fn(async (_p, a, t) => void calls.push(`pending:${a.id}:${t}`)),
    turnReady: vi.fn(async (_p, a, t, _an, o) => void calls.push(`ready:${a.id}:${t}:${o}`)),
    turnFailed: vi.fn(async (_p, a, t, e) => void calls.push(`failed:${a.id}:${t}:${e}`)),
    turnSuperseded: vi.fn(async (_p, a, t) => void calls.push(`superseded:${a.id}:${t}`)),
    permissionRequested: vi.fn(async (_p, a, r) => void calls.push(`perm:${a.id}:${r.id}:${a.name}`)),
    permissionResolved: vi.fn(async (_p, a, r, b) => void calls.push(`resolved:${a.id}:${r}:${b}`)),
  };
  const store: StateStore = { load: async () => [], schedule: () => undefined, flush: async () => undefined };
  let current: AnalyzerSettings = { ...DEFAULT_ANALYZER_SETTINGS, ...(options.settings ?? {}) };
  const service = new SessionManagerService({
    store,
    analyzer,
    notifier,
    settings: { current: () => current, refresh: async () => current },
    checkAnalyzer: async () => null,
  });
  const paseo = {
    agents: {
      ref: () => ({
        refresh: async () => ({ agent: { labels: options.labels ?? {} }, project: null }),
      }),
    },
  } as unknown as PaseoApi;
  service.touchPaseo(paseo);
  return { service, pending, calls, setSettings: (patch: Partial<AnalyzerSettings>) => (current = { ...current, ...patch }) };
}

const flush = async () => {
  for (let index = 0; index < 8; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
};

describe("session cards from the service", () => {
  it("shows a pending card on turn end and a ready card when analysis lands", async () => {
    const { service, pending, calls } = harness();
    service.onTurnEnded(turnEnded("t1", "完成了"));
    await flush();
    expect(calls).toEqual(["pending:a1:t1"]);
    pending[0].resolve(result());
    await service.waitForIdle();
    await flush();
    expect(calls).toEqual(["pending:a1:t1", "ready:a1:t1:completed"]);
  });

  it("shows a failed card when analysis fails", async () => {
    const { service, pending, calls } = harness();
    service.onTurnEnded(turnEnded("t1", "x"));
    await flush();
    pending[0].reject(new Error("分析超时"));
    await service.waitForIdle();
    await flush();
    expect(calls).toEqual(["pending:a1:t1", "failed:a1:t1:分析超时"]);
  });

  it("marks the old card superseded when a newer turn arrives", async () => {
    const { service, pending, calls } = harness();
    service.onTurnEnded(turnEnded("t1", "一"));
    await flush();
    service.onTurnEnded(turnEnded("t2", "二"));
    pending[0].resolve(result());
    await flush();
    expect(calls).toContain("superseded:a1:t1");
    expect(calls).toContain("pending:a1:t2");
    expect(calls.filter((call) => call.startsWith("ready"))).toEqual([]);
    pending[1].resolve(result());
    await service.waitForIdle();
    await flush();
    expect(calls.at(-1)).toBe("ready:a1:t2:completed");
  });

  it("produces no cards for excluded helper agents or herald.role, even if the setting is cleared", async () => {
    const herald = harness({ labels: { "herald.role": "summarizer" }, settings: { excludedLabelKeys: "" } });
    herald.service.onTurnEnded(turnEnded("t1", "x"));
    herald.service.onPermissionRequested({
      agent: agent(),
      request: { id: "r1", kind: "tool", name: "Bash" },
    } as unknown as PermissionRequestedEvent);
    await flush();
    expect(herald.calls).toEqual([]);
    const other = harness({ labels: { "other.plugin": "1" }, settings: { excludedLabelKeys: "other.plugin" } });
    other.service.onTurnEnded(turnEnded("t1", "x"));
    await flush();
    expect(other.calls).toEqual([]);
  });

  it("produces no cards when analysis is disabled", async () => {
    const { service, calls } = harness({ settings: { enabled: false } });
    service.onTurnEnded(turnEnded("t1", "x"));
    await flush();
    expect(calls).toEqual([]);
  });

  it("closes pending cards when analysis is switched off", async () => {
    const { service, calls, setSettings } = harness();
    service.onTurnEnded(turnEnded("t1", "x"));
    await flush();
    setSettings({ enabled: false });
    service.settingsChanged();
    await flush();
    expect(calls).toEqual(["pending:a1:t1", "failed:a1:t1:自动分析已关闭"]);
  });

  it("cards permission requests immediately and updates them when resolved", async () => {
    const { service, calls } = harness();
    service.onPermissionRequested({
      agent: agent(),
      request: { id: "r1", kind: "tool", name: "Bash" },
    } as unknown as PermissionRequestedEvent);
    await flush();
    service.onPermissionResolved({
      agent: agent(),
      requestId: "r1",
      resolution: { behavior: "deny" },
    } as unknown as PermissionResolvedEvent);
    await flush();
    expect(calls).toEqual(["perm:a1:r1:登录页", "resolved:a1:r1:deny"]);
  });
});
