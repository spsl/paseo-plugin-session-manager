import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_ANALYSIS_RUNS, type Analysis, type Turn } from "../shared/types";
import {
  openDigestStore,
  RAW_DIGEST_MAX_CHARS,
  type DigestStore,
  type NewAnalysisRun,
} from "./digest-store";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sm-digests-"));
});
afterEach(async () => {
  store?.close();
  store = null;
});

let store: DigestStore | null = null;
function open(name = "history.db"): DigestStore {
  store = openDigestStore(join(dir, name));
  return store;
}

const turn = (id: string, output = "回复", overrides: Partial<Turn> = {}): Turn => ({
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
  ...overrides,
});

describe("digest store", () => {
  it("upserts a turn and lists it oldest-first", () => {
    const store = open();
    store.upsertTurn("s1", turn("t1"), [], 10);
    store.upsertTurn("s1", turn("t2", "更长的回复", { completedAt: 2_000 }), [], 11);
    store.upsertTurn("s2", turn("x"), [], 12);
    const rows = store.listTurns("s1");
    expect(rows.map((row) => row.turnId)).toEqual(["t1", "t2"]);
    expect(rows[0]).toMatchObject({
      dedupeKey: "key-t1-回复",
      userInput: "输入-t1",
      outcome: "completed",
      subAgents: [],
      digestSource: "raw",
      digest: "回复",
      step: null,
    });
  });

  it("stores a raw digest for short replies and none for long ones", () => {
    const store = open();
    store.upsertTurn("s1", turn("short", "短"), [], 1);
    store.upsertTurn("s1", turn("long", "长".repeat(RAW_DIGEST_MAX_CHARS + 1), { completedAt: 2_000 }), [], 1);
    const [short, long] = store.listTurns("s1");
    expect(short.digest).toBe("短");
    expect(short.digestSource).toBe("raw");
    expect(long.digest).toBeNull();
    expect(long.digestSource).toBeNull();
  });

  it("keeps the model digest when the same content is upserted again", () => {
    const store = open();
    const analyzed = turn("t1", "长".repeat(600));
    store.upsertTurn("s1", analyzed, [], 1);
    store.writeAnalysis("s1", "t1", analyzed.dedupeKey, "改完了", "模型摘要", 2);
    store.upsertTurn("s1", turn("t1", "长".repeat(600)), [], 3);
    const row = store.listTurns("s1")[0];
    expect(row.step).toBe("改完了");
    expect(row.digest).toBe("模型摘要");
    expect(row.digestSource).toBe("model");
  });

  it("resets step/digest when the turn content changes (dedupe_key)", () => {
    const store = open();
    const analyzed = turn("t1", "长".repeat(600));
    store.upsertTurn("s1", analyzed, [], 1);
    store.writeAnalysis("s1", "t1", analyzed.dedupeKey, "旧步骤", "旧摘要", 2);
    store.upsertTurn("s1", turn("t1", "不同的内容", { dedupeKey: "key-new" }), [], 3);
    const row = store.listTurns("s1")[0];
    expect(row.step).toBeNull();
    // 新内容够短，落回原文摘要
    expect(row.digest).toBe("不同的内容");
    expect(row.digestSource).toBe("raw");
  });

  it("keeps the stored digest when analysis writes an empty one", () => {
    const store = open();
    const analyzed = turn("t1", "短回复");
    store.upsertTurn("s1", analyzed, [], 1);
    store.writeAnalysis("s1", "t1", analyzed.dedupeKey, "这一步步骤名", "", 2);
    const row = store.listTurns("s1")[0];
    expect(row.step).toBe("这一步步骤名");
    expect(row.digest).toBe("短回复");
    expect(row.digestSource).toBe("raw");
  });

  it("ignores analysis digests for unknown turns", () => {
    const store = open();
    store.writeAnalysis("s1", "ghost", "any", "步骤", "摘要", 1);
    expect(store.listTurns("s1")).toEqual([]);
  });

  it("ignores the write-back when the row's dedupe_key no longer matches", () => {
    const store = open();
    const analyzed = turn("t1", "长".repeat(600));
    store.upsertTurn("s1", analyzed, [], 1);
    // 分析进行中同一 turnId 换了新内容：行被重置
    const replaced = turn("t1", "短的新内容", { dedupeKey: "key-new" });
    store.upsertTurn("s1", replaced, [], 2);
    // 旧内容的摘要写回：dedupe_key 不匹配，step/digest 都不落
    store.writeAnalysis("s1", "t1", analyzed.dedupeKey, "旧步骤", "旧摘要", 3);
    const row = store.listTurns("s1")[0];
    expect(row.step).toBeNull();
    expect(row.digest).toBe("短的新内容");
    expect(row.digestSource).toBe("raw");
  });

  it("never overwrites a raw digest with a model digest, only the step", () => {
    const store = open();
    const analyzed = turn("t1", "短回复");
    store.upsertTurn("s1", analyzed, [], 1);
    // 模型无视 needsDigest=false 也给了摘要：raw 原文保留
    store.writeAnalysis("s1", "t1", analyzed.dedupeKey, "步骤", "模型写的摘要", 2);
    const row = store.listTurns("s1")[0];
    expect(row.step).toBe("步骤");
    expect(row.digest).toBe("短回复");
    expect(row.digestSource).toBe("raw");
  });

  it("persists sub-agents and declared result as JSON", () => {
    const store = open();
    store.upsertTurn(
      "s1",
      turn("t1", "完成：审查好了", { declared: { kind: "done", text: "审查好了" } }),
      [
        { callId: "c1", type: "Explore", description: "找代码", status: "completed" },
        { callId: "c2", type: "Task", description: "跑测试", status: "failed" },
      ],
      1,
    );
    const row = store.listTurns("s1")[0];
    expect(row.declared).toEqual({ kind: "done", text: "审查好了" });
    expect(row.subAgents).toEqual([
      { callId: "c1", type: "Explore", description: "找代码", status: "completed" },
      { callId: "c2", type: "Task", description: "跑测试", status: "failed" },
    ]);
  });

  it("truncates stored user input to 300 chars", () => {
    const store = open();
    store.upsertTurn("s1", turn("t1", "x", { userInput: "问".repeat(500) }), [], 1);
    expect(store.listTurns("s1")[0].userInput).toBe("问".repeat(300));
  });

  it("removeSession deletes only that session's rows", () => {
    const store = open();
    store.upsertTurn("s1", turn("t1"), [], 1);
    store.upsertTurn("s2", turn("t2"), [], 1);
    store.removeSession("s1");
    expect(store.listTurns("s1")).toEqual([]);
    expect(store.listTurns("s2")).toHaveLength(1);
  });

  it("pruneOrphans drops rows whose session is gone", () => {
    const store = open();
    store.upsertTurn("s1", turn("t1"), [], 1);
    store.upsertTurn("s2", turn("t2"), [], 1);
    store.pruneOrphans(new Set(["s2"]));
    expect(store.listTurns("s1")).toEqual([]);
    expect(store.listTurns("s2")).toHaveLength(1);
  });

  it("returns a disabled store when the file cannot be opened", () => {
    // A regular file blocks the recursive mkdir, so open fails.
    const blocker = join(dir, "a-file");
    return writeFile(blocker, "x").then(() => {
      const disabled = openDigestStore(join(blocker, "history.db"));
      expect(disabled.listTurns("s1")).toEqual([]);
      disabled.upsertTurn("s1", turn("t1"), [], 1);
      disabled.recordRun("s1", run());
      expect(disabled.listRuns("s1")).toEqual([]);
      expect(disabled.getRun("s1", 1)).toBeNull();
      disabled.close();
    });
  });
});

const analysisResult = (confidence = 0.9): Analysis => ({
  title: "标题",
  summary: "判断",
  goal: "目标",
  status: "in_progress",
  progress: ["进展"],
  completed: [],
  nextSteps: ["下一步"],
  blockers: [],
  needsUserAttention: false,
  confidence,
  turnDigests: [{ turnId: "t1", step: "步骤", digest: "摘要" }],
});

const run = (overrides: Partial<NewAnalysisRun> = {}): NewAnalysisRun => ({
  turnId: "t1",
  startedAt: 1_000,
  durationMs: 2_500,
  userInput: "用户的话",
  reanalysis: false,
  agent: "claude",
  model: "opus",
  inputChars: 1_234,
  newTurns: 1,
  digestCount: 3,
  outcome: "applied",
  error: null,
  analysis: analysisResult(),
  ...overrides,
});

describe("analysis runs", () => {
  it("lists runs newest first without their results and returns one in full", () => {
    const store = open();
    store.recordRun("s1", run({ startedAt: 1 }));
    store.recordRun(
      "s1",
      run({ startedAt: 2, outcome: "failed", error: "分析超时", analysis: null, reanalysis: true }),
    );
    store.recordRun("s2", run());
    const runs = store.listRuns("s1");
    expect(runs.map((entry) => entry.startedAt)).toEqual([2, 1]);
    expect(runs[0]).toMatchObject({
      outcome: "failed",
      error: "分析超时",
      confidence: null,
      status: null,
      reanalysis: true,
    });
    expect(runs[1]).toMatchObject({
      turnId: "t1",
      durationMs: 2_500,
      userInput: "用户的话",
      agent: "claude",
      model: "opus",
      outcome: "applied",
      confidence: 0.9,
      status: "in_progress",
      reanalysis: false,
    });
    expect(runs[1]).not.toHaveProperty("analysis");

    const full = store.getRun("s1", runs[1].id);
    expect(full).toMatchObject({ inputChars: 1_234, newTurns: 1, digestCount: 3 });
    expect(full?.analysis).toEqual(analysisResult());
    expect(store.getRun("s2", runs[1].id)).toBeNull();
  });

  it("truncates the stored user input to 300 chars", () => {
    const store = open();
    store.recordRun("s1", run({ userInput: "问".repeat(500) }));
    expect(store.listRuns("s1")[0].userInput).toBe("问".repeat(300));
  });

  it("keeps only the newest MAX_ANALYSIS_RUNS per session", () => {
    const store = open();
    for (let index = 0; index < MAX_ANALYSIS_RUNS + 5; index += 1) {
      store.recordRun("s1", run({ startedAt: index }));
    }
    store.recordRun("s2", run());
    const runs = store.listRuns("s1");
    expect(runs).toHaveLength(MAX_ANALYSIS_RUNS);
    expect(runs[0].startedAt).toBe(MAX_ANALYSIS_RUNS + 4);
    expect(runs.at(-1)?.startedAt).toBe(5);
    expect(store.listRuns("s2")).toHaveLength(1);
  });

  it("removeSession and pruneOrphans clear runs too", () => {
    const store = open();
    store.recordRun("s1", run());
    store.recordRun("s2", run());
    // s3 has runs but no turn rows; pruning must still find it.
    store.recordRun("s3", run());
    store.removeSession("s1");
    expect(store.listRuns("s1")).toEqual([]);
    store.pruneOrphans(new Set(["s2"]));
    expect(store.listRuns("s2")).toHaveLength(1);
    expect(store.listRuns("s3")).toEqual([]);
  });
});
