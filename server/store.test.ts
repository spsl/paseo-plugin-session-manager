import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newRecord } from "./lifecycle";
import { MAX_HISTORY_ENTRIES } from "../shared/types";
import {
  JsonStateStore,
  MAX_SESSIONS,
  MAX_TURNS_PER_SESSION,
  withTurnHistory,
  type SessionRecord,
} from "./store";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sm-store-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function make(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { ...newRecord({ id, provider: "codex", cwd: "/w" }, 1), ...overrides };
}

const turn = (id: string, text = "out") => ({
  id,
  dedupeKey: id,
  userInput: "in",
  agentOutput: text,
  outcome: "completed" as const,
  completedAt: 5,
  contextIncomplete: false,
  declared: null,
});

describe("JsonStateStore", () => {
  it("round-trips records and leaves no tmp files", async () => {
    const path = join(dir, "sub", "state.json");
    const store = new JsonStateStore(path);
    const record = make("a", {
      turns: [turn("t1")],
      firstUserMessage: "hello",
      firstUserMessageKnown: true,
      manualStatusOverride: "completed",
      deferredUntil: 9_999,
      deferToQueue: true,
      titleState: { lastWritten: "x", userOwned: true, lastWriteError: null },
      analysisState: "ready",
    });
    store.schedule(() => [record]);
    await store.flush();
    expect(await new JsonStateStore(path).load()).toEqual([record]);
    expect((await readdir(join(dir, "sub"))).sort()).toEqual(["state.json"]);
  });

  it("turns running analyses into failed ones on load", async () => {
    const path = join(dir, "state.json");
    const store = new JsonStateStore(path);
    store.schedule(() => [make("a", { analysisState: "running", turns: [turn("t")] })]);
    await store.flush();
    const [loaded] = await new JsonStateStore(path).load();
    expect(loaded.analysisState).toBe("failed");
    expect(loaded.analysisError).toBe("上次分析在插件重启前中断");
  });

  it("bounds sessions, turns and text length", async () => {
    const path = join(dir, "state.json");
    const store = new JsonStateStore(path);
    const records = Array.from({ length: MAX_SESSIONS + 5 }, (_, index) =>
      make(`s${index}`, { updatedAt: index + 1 }),
    );
    records[MAX_SESSIONS + 4].turns = Array.from({ length: 20 }, (_, index) =>
      turn(`t${index}`, "x".repeat(20_000)),
    );
    store.schedule(() => records);
    await store.flush();
    const loaded = await new JsonStateStore(path).load();
    expect(loaded).toHaveLength(MAX_SESSIONS);
    expect(loaded[0].id).toBe(`s${MAX_SESSIONS + 4}`);
    expect(loaded[0].turns).toHaveLength(MAX_TURNS_PER_SESSION);
    expect(loaded[0].turns[0].agentOutput.length).toBe(16_000);
    expect(loaded.some((record) => record.id === "s0")).toBe(false);
  });

  it("loads corrupt or missing files as empty and skips bad entries", async () => {
    const path = join(dir, "state.json");
    expect(await new JsonStateStore(path).load()).toEqual([]);
    await writeFile(path, "{not json");
    expect(await new JsonStateStore(path).load()).toEqual([]);
    await writeFile(path, JSON.stringify({ version: 1, sessions: [null, { id: 3 }, { id: "ok", analysisState: "ready", updatedAt: 1 }] }));
    const loaded = await new JsonStateStore(path).load();
    expect(loaded.map((record) => record.id)).toEqual(["ok"]);
    // Legacy records predate the resume fields: they hydrate to idle/null.
    expect(loaded[0]).toMatchObject({
      deferredUntil: null,
      deferToQueue: false,
      interruptedAt: null,
      resumeState: "idle",
      resumeError: null,
    });
  });

  it("persists dormant and interruptedAt but resets runtime resume fields on load", async () => {
    const path = join(dir, "state.json");
    const store = new JsonStateStore(path);
    store.schedule(() => [
      make("a", {
        liveness: "dormant",
        interruptedAt: 7,
        resumeState: "resuming",
        resumeError: "恢复失败：x",
      }),
    ]);
    await store.flush();
    const [loaded] = await new JsonStateStore(path).load();
    expect(loaded).toMatchObject({
      liveness: "dormant",
      interruptedAt: 7,
      resumeState: "idle",
      resumeError: null,
    });
  });

  it("round-trips declared results and the team notification marker", async () => {
    const path = join(dir, "state.json");
    const store = new JsonStateStore(path);
    store.schedule(() => [
      make("a", {
        interruptedAt: 9,
        interruptNotifiedAt: 9,
        turns: [
          { ...turn("t1"), declared: { kind: "blocked", text: "缺权限" } },
          { ...turn("t2"), declared: { kind: "nope", text: "x" } as never },
        ],
      }),
    ]);
    await store.flush();
    const [loaded] = await new JsonStateStore(path).load();
    expect(loaded.interruptNotifiedAt).toBe(9);
    expect(loaded.turns.map((t) => t.declared)).toEqual([{ kind: "blocked", text: "缺权限" }, null]);
  });

  it("round-trips the 之前 history and short analysis fields, dropping bad entries", async () => {
    const path = join(dir, "state.json");
    const store = new JsonStateStore(path);
    const analysis = {
      title: "标题",
      summary: "s",
      goal: "g",
      status: "completed" as const,
      progress: [],
      completed: [],
      nextSteps: ["下一步"],
      blockers: [],
      needsUserAttention: false,
      confidence: 0.9,
      done: ["做完了"],
      now: "等你确认",
    };
    await store.save([
      make("a", {
        analysis,
        history: [{ turnId: "t1", at: 5, text: "做完了" }],
        historyBaseTurnId: "t0",
      }),
    ]);
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.sessions[0].history.push({ turnId: "t2", text: "缺时间" });
    await writeFile(path, JSON.stringify(raw));
    const [loaded] = await store.load();
    expect(loaded.history).toEqual([{ turnId: "t1", at: 5, text: "做完了" }]);
    expect(loaded.historyBaseTurnId).toBe("t0");
    expect(loaded.analysis).toMatchObject({ done: ["做完了"], now: "等你确认" });
  });

  it("writes the file with mode 0600", async () => {
    const path = join(dir, "state.json");
    const store = new JsonStateStore(path);
    store.schedule(() => [make("a")]);
    await store.flush();
    const { statSync } = await import("node:fs");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
  });
});

describe("withTurnHistory", () => {
  const entry = (turnId: string, text: string) => ({ turnId, at: 1, text });

  it("appends a turn's items and replaces them when the turn is analyzed again", () => {
    const first = withTurnHistory([entry("t1", "一")], "t2", 2, ["二", "三"]);
    expect(first.map((item) => item.text)).toEqual(["一", "二", "三"]);
    expect(first[1]).toEqual({ turnId: "t2", at: 2, text: "二" });
    const again = withTurnHistory(first, "t2", 3, ["新二"]);
    expect(again.map((item) => item.text)).toEqual(["一", "新二"]);
  });

  it("keeps the history for older analyzers and caps its length", () => {
    expect(withTurnHistory([entry("t1", "一")], "t2", 2, undefined)).toEqual([entry("t1", "一")]);
    const many = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, index) => entry(`t${index}`, `${index}`));
    const capped = withTurnHistory(many, "last", 9, ["最新"]);
    expect(capped).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(capped.at(-1)?.text).toBe("最新");
    expect(capped[0].text).toBe("1");
  });
});
