import { describe, expect, it } from "vitest";
import { newRecord } from "./lifecycle";
import { projectDetail, projectView } from "./projection";
import type { SessionRecord } from "./store";

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return { ...newRecord({ id: "a", provider: "codex", cwd: "/w" }, 1), ...overrides };
}

const analysis = (status: "completed" | "blocked" | "waiting_for_user" | "unclear" | "in_progress") => ({
  title: "t",
  summary: "s",
  goal: "g",
  status,
  progress: [],
  completed: [],
  nextSteps: [],
  blockers: [],
  needsUserAttention: false,
  confidence: 0.9,
});

describe("projectView", () => {
  it("defaults to unclear", () => {
    const view = projectView(record());
    expect(view).toMatchObject({ effectiveStatus: "unclear", column: "unclear", needsAttention: false });
  });

  it("manual override beats everything while live", () => {
    const view = projectView(
      record({ manualStatusOverride: "completed", pendingPermissionCount: 1, lifecycle: "working" }),
    );
    expect(view.effectiveStatus).toBe("completed");
    expect(view.column).toBe("completed");
  });

  it("pending permission beats working and analysis", () => {
    const view = projectView(record({ pendingPermissionCount: 1, lifecycle: "working", analysis: analysis("completed") }));
    expect(view).toMatchObject({ effectiveStatus: "waiting_for_user", column: "waiting_for_user", needsAttention: true });
  });

  it("working beats analysis", () => {
    expect(projectView(record({ lifecycle: "working", analysis: analysis("completed") })).column).toBe("in_progress");
  });

  it("blocked goes to the needs-action column", () => {
    const view = projectView(record({ analysis: analysis("blocked") }));
    expect(view).toMatchObject({ effectiveStatus: "blocked", column: "waiting_for_user", needsAttention: true, modelStatus: "blocked" });
  });

  it("non-live sessions are closed and need no attention", () => {
    const view = projectView(
      record({ liveness: "closed", manualStatusOverride: "completed", pendingPermissionCount: 2, analysis: analysis("waiting_for_user") }),
    );
    expect(view).toMatchObject({ column: "closed", needsAttention: false, effectiveStatus: "waiting_for_user" });
  });

  it("parks an unexpired queued defer in the deferred column without attention", () => {
    const now = 1_000;
    const view = projectView(
      record({ deferredUntil: now + 60_000, deferToQueue: true, pendingPermissionCount: 1, lifecycle: "working" }),
      now,
    );
    expect(view).toMatchObject({
      column: "deferred",
      deferredUntil: now + 60_000,
      deferToQueue: true,
      needsAttention: false,
      effectiveStatus: "waiting_for_user",
    });
  });

  it("keeps an in-place defer in its column but still counts no attention", () => {
    const now = 1_000;
    const view = projectView(
      record({ deferredUntil: now + 60_000, deferToQueue: false, pendingPermissionCount: 1 }),
      now,
    );
    expect(view).toMatchObject({ column: "waiting_for_user", deferToQueue: false, needsAttention: false });
  });

  it("treats an expired defer as not deferred and marks the defer end", () => {
    const now = 1_000;
    const view = projectView(
      record({ deferredUntil: now - 1, deferToQueue: true, pendingPermissionCount: 1 }),
      now,
    );
    expect(view).toMatchObject({
      column: "waiting_for_user",
      deferredUntil: null,
      deferToQueue: false,
      deferEndedAt: now - 1,
      needsAttention: true,
    });
  });

  it("reports no defer-end marker for active or absent defers", () => {
    const now = 1_000;
    const deferred = projectView(record({ deferredUntil: now + 60_000 }), now);
    expect(deferred.deferEndedAt).toBeNull();
    expect(projectView(record(), now).deferEndedAt).toBeNull();
  });

  it("clears the defer in the view for non-live sessions", () => {
    const now = 1_000;
    const view = projectView(
      record({ liveness: "closed", deferredUntil: now + 60_000, deferToQueue: true }),
      now,
    );
    expect(view).toMatchObject({
      column: "closed",
      deferredUntil: null,
      deferToQueue: false,
      deferEndedAt: null,
    });
  });

  it("projects a restart-interrupted dormant session into the needs-action column", () => {
    const view = projectView(
      record({ liveness: "dormant", interruptedAt: 5, analysis: analysis("completed") }),
    );
    expect(view).toMatchObject({
      column: "waiting_for_user",
      effectiveStatus: "waiting_for_user",
      liveness: "dormant",
      needsAttention: true,
    });
  });

  it("projects dormant sessions into status columns and honors deferrals", () => {
    const now = 1_000;
    const deferred = projectView(
      record({ liveness: "dormant", deferredUntil: now + 60_000, deferToQueue: true }),
      now,
    );
    expect(deferred).toMatchObject({ column: "deferred", liveness: "dormant" });
    const plain = projectView(record({ liveness: "dormant", analysis: analysis("completed") }), now);
    expect(plain).toMatchObject({ column: "completed", needsAttention: false });
  });

  it("manual override still beats the interruption flag on dormant sessions", () => {
    const view = projectView(
      record({ liveness: "dormant", manualStatusOverride: "completed", interruptedAt: 1 }),
    );
    expect(view).toMatchObject({ effectiveStatus: "completed", column: "completed" });
  });

  it("exposes turn count and the first line of the last user input", () => {
    const turn = (id: string, userInput: string) => ({
      id,
      dedupeKey: id,
      userInput,
      agentOutput: "o",
      outcome: "completed" as const,
      completedAt: 1,
      contextIncomplete: false,
    });
    const base = record({ turns: [turn("1", "第一"), turn("2", "最后一条\n第二行")] });
    expect(projectView(base)).toMatchObject({ turnCount: 2, lastUserInput: "最后一条 第二行" });
    expect(projectDetail(base).turns).toHaveLength(2);
  });
});

describe("declared results", () => {
  const turnWith = (kind: "done" | "blocked" | "failed") => ({
    id: "t1",
    dedupeKey: "k",
    userInput: "u",
    agentOutput: "o",
    outcome: "completed" as const,
    completedAt: 2,
    contextIncomplete: false,
    declared: { kind, text: "结论" },
  });

  it("beats the model's verdict and maps blocked and failed to 需要处理", () => {
    expect(
      projectView(record({ turns: [turnWith("done")], analysis: analysis("waiting_for_user") })),
    ).toMatchObject({ effectiveStatus: "completed", column: "completed", declared: { kind: "done" } });
    expect(
      projectView(record({ turns: [turnWith("failed")], analysis: analysis("completed") })),
    ).toMatchObject({ effectiveStatus: "blocked", column: "waiting_for_user", needsAttention: true });
  });

  it("yields to manual override and to a running turn", () => {
    expect(
      projectView(record({ turns: [turnWith("blocked")], manualStatusOverride: "completed" })).effectiveStatus,
    ).toBe("completed");
    expect(projectView(record({ turns: [turnWith("done")], lifecycle: "working" })).effectiveStatus).toBe(
      "in_progress",
    );
  });

  it("only the latest turn counts", () => {
    const later = { ...turnWith("done"), id: "t2", declared: null };
    const view = projectView(
      record({ turns: [turnWith("blocked"), later], analysis: analysis("in_progress") }),
    );
    expect(view).toMatchObject({ effectiveStatus: "in_progress", declared: null });
  });
});
