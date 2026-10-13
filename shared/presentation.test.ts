import { describe, expect, it } from "vitest";
import {
  analysisStatusLabel,
  branchLabel,
  columnForStatus,
  deferClockLabel,
  deferClockTimestamp,
  formatDeferRemaining,
  formatDeferUntil,
  formatShortTimeAgo,
  formatStepTime,
  livenessLabel,
  nowLine,
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

  it("resolves absolute defer targets to local wall-clock time", () => {
    const now = new Date(2026, 5, 15, 10, 30, 0).getTime();
    expect(deferClockTimestamp({ dayOffset: 0, hour: 14 }, now)).toBe(
      new Date(2026, 5, 15, 14, 0, 0).getTime(),
    );
    expect(deferClockTimestamp({ dayOffset: 2, hour: 9 }, now)).toBe(
      new Date(2026, 5, 17, 9, 0, 0).getTime(),
    );
    expect(deferClockLabel({ dayOffset: 1, hour: 18 })).toBe("至明天 18:00");
  });
});

describe("nowLine", () => {
  const analysis = {
    title: "标题",
    summary: "很长的一段总结",
    speech: "标题：已完成，等你确认",
    goal: "g",
    status: "waiting_for_user" as const,
    progress: [],
    completed: [],
    nextSteps: [],
    blockers: ["缺少接口文档"],
    needsUserAttention: true,
    confidence: 0.9,
    now: "等你决定：存成文件还是改成日报",
  };
  const live = { running: false, pendingPermissions: 0, userText: null, activity: null };

  it("prefers live running state over the last analysis", () => {
    const session = makeSession({ analysis, effectiveStatus: "waiting_for_user" });
    expect(
      nowLine(session, { ...live, running: true, userText: "把总结\n存成 md", activity: "Bash：npm test" }),
    ).toEqual({ tone: "working", text: "正在处理：把总结 存成 md", detail: "Bash：npm test" });
    expect(nowLine(makeSession({ lifecycle: "working" }), null).text).toBe("正在运行");
  });

  it("asks for permission before anything else", () => {
    const line = nowLine(makeSession({ analysis }), { ...live, running: true, pendingPermissions: 2 });
    expect(line).toMatchObject({ tone: "waiting", text: "等你授权（2 个请求）" });
  });

  it("uses the analysis now sentence, else speech, and names the blocker", () => {
    expect(nowLine(makeSession({ analysis, effectiveStatus: "waiting_for_user" }), live)).toEqual({
      tone: "waiting",
      text: "等你决定：存成文件还是改成日报",
      detail: null,
    });
    const { now: _now, ...legacy } = analysis;
    const blocked = nowLine(makeSession({ analysis: legacy, effectiveStatus: "blocked" }), live);
    expect(blocked).toEqual({ tone: "blocked", text: "标题：已完成，等你确认", detail: "卡在：缺少接口文档" });
  });

  it("covers closed, dormant and not-yet-analyzed sessions", () => {
    expect(nowLine(makeSession({ liveness: "closed", analysis }), null)).toMatchObject({ text: "会话已关闭" });
    expect(nowLine(makeSession({ liveness: "dormant", interruptedAt: 5 }), null).text).toBe(
      "Paseo 重启时任务被中断",
    );
    expect(nowLine(makeSession({ analysisState: "queued" }), live).text).toBe("等待分析，暂无分析结论");
    expect(
      nowLine(makeSession({ declared: { kind: "done", text: "已合并" }, effectiveStatus: "completed" }), live),
    ).toMatchObject({ tone: "done", text: "完成：已合并" });
  });
});

describe("formatStepTime", () => {
  it("shows the clock today and the date otherwise", () => {
    const now = new Date(2026, 9, 13, 22, 0).getTime();
    expect(formatStepTime(new Date(2026, 9, 13, 9, 5).getTime(), now)).toBe("09:05");
    expect(formatStepTime(new Date(2026, 9, 12, 23, 59).getTime(), now)).toBe("10-12 23:59");
  });
});
