import { describe, expect, it } from "vitest";
import {
  analysisStatusLabel,
  branchLabel,
  columnForStatus,
  formatDeferRemaining,
  formatDeferUntil,
  formatShortTimeAgo,
  livenessLabel,
  resumeStateLabel,
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

  it("labels dormant sessions 未连接 and reports resume progress", () => {
    expect(livenessLabel("dormant")).toBe("未连接");
    expect(livenessLabel("live")).toBe("活跃");
    expect(resumeStateLabel(makeSession({ liveness: "dormant" }))).toBe("未连接");
    expect(resumeStateLabel(makeSession({ liveness: "dormant", resumeState: "queued" }))).toBe(
      "恢复中…",
    );
    expect(resumeStateLabel(makeSession({ liveness: "dormant", resumeState: "resuming" }))).toBe(
      "恢复中…",
    );
    expect(resumeStateLabel(makeSession({ liveness: "dormant", resumeState: "failed" }))).toBe(
      "恢复失败",
    );
    expect(resumeStateLabel(makeSession({ resumeState: "failed" }))).toBeNull();
  });

  it("formats the defer countdown and resume time", () => {
    const now = new Date(2026, 5, 15, 10, 30, 0).getTime();
    expect(formatDeferRemaining(now - 1, now)).toBe("即将恢复");
    expect(formatDeferRemaining(now + 30 * 60_000, now)).toBe("剩余 30 分钟");
    expect(formatDeferRemaining(now + 5 * 3_600_000, now)).toBe("剩余 5 小时");
    expect(formatDeferRemaining(now + 3 * 86_400_000, now)).toBe("剩余 3 天");

    expect(formatDeferUntil(now + 3_600_000, now)).toBe("11:30");
    expect(formatDeferUntil(now + 40 * 3_600_000, now)).toBe("6月17日 02:30");
  });
});
