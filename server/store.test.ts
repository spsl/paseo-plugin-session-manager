import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newRecord } from "./lifecycle";
import { JsonStateStore, MAX_SESSIONS, MAX_TURNS_PER_SESSION, type SessionRecord } from "./store";

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
