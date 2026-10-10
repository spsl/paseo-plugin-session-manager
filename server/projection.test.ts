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
