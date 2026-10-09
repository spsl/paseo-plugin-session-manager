import { describe, expect, it } from "vitest";
import {
  analysisStatusLabel,
  branchLabel,
  columnForStatus,
  formatShortTimeAgo,
  sessionTitle,
  workspaceLabel,
} from "./presentation";
import { makeSession } from "./test-fixtures";

describe("board presentation", () => {
  it("places blocked work in the needs-action column", () => {
    expect(columnForStatus("blocked")).toBe("waiting_for_user");
    expect(columnForStatus("completed")).toBe("completed");
  });

  it("uses the workspace name, else the last two cwd segments", () => {
    expect(workspaceLabel(makeSession({ workspaceName: "feature-x" }))).toBe("feature-x");
    expect(workspaceLabel(makeSession({ cwd: "/Users/ada/projects/orcb" }))).toBe("projects/orcb");
    expect(workspaceLabel(makeSession({ cwd: "C:\\Users\\Ada\\repo\\app" }))).toBe("repo/app");
    expect(workspaceLabel(makeSession({ cwd: "" }))).toBe("未知");
  });

  it("normalizes branch refs and hides missing branches", () => {
    expect(branchLabel(makeSession({ branch: "refs/heads/feature/card" }))).toBe("feature/card");
    expect(branchLabel(makeSession({ branch: "" }))).toBeNull();
  });

  it("prefers the generated title, then agent title, prompt, provider", () => {
    const analysis = {
      title: "重构会话分析配置",
      summary: "",
      goal: "",
      status: "in_progress" as const,
      progress: [],
      completed: [],
      nextSteps: [],
      blockers: [],
      needsUserAttention: false,
      confidence: 0.8,
    };
    expect(sessionTitle(makeSession({ agentTitle: "Codex", analysis }))).toBe("重构会话分析配置");
    expect(sessionTitle(makeSession({ agentTitle: "Codex" }))).toBe("Codex");
    expect(sessionTitle(makeSession({ agentTitle: null }))).toBe("实现会话看板");
    expect(sessionTitle(makeSession({ agentTitle: null, lastUserInput: null }))).toBe("codex 会话");
  });

  it("labels statuses and formats Chinese relative time", () => {
    expect(analysisStatusLabel("blocked")).toBe("阻塞");
    expect(formatShortTimeAgo(1_000, 1_000 + 30_000)).toBe("刚刚");
    expect(formatShortTimeAgo(0, 5 * 60_000)).toBe("5分钟前");
    expect(formatShortTimeAgo(0, 3 * 3_600_000)).toBe("3小时前");
    expect(formatShortTimeAgo(0, 2 * 86_400_000)).toBe("2天前");
  });
});
