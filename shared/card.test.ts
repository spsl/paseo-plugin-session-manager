import { describe, expect, it } from "vitest";
import {
  SessionCardSchema,
  failedTurnCard,
  pendingTurnCard,
  permissionCard,
  permissionSpeech,
  readyTurnCard,
  resolvedPermissionCard,
  sessionDisplayName,
  shortError,
  supersededTurnCard,
} from "./card";
import type { Analysis } from "./types";

const analysis: Analysis = {
  title: "登录页",
  summary: "已完成登录页。",
  speech: "登录页：记住密码功能已完成并通过测试。",
  goal: "g",
  status: "completed",
  progress: [],
  completed: [],
  nextSteps: ["合并分支", "发布"],
  blockers: [],
  needsUserAttention: false,
  confidence: 0.9,
};

describe("turn cards", () => {
  it("builds a pending card", () => {
    const card = pendingTurnCard();
    expect(card).toMatchObject({ state: "pending", text: "正在分析…", speak: null });
    expect(SessionCardSchema.safeParse(card).success).toBe(true);
  });

  it("builds a ready card with label, sentence and first next step", () => {
    const card = readyTurnCard(analysis);
    expect(card).toMatchObject({
      state: "ready",
      label: "已完成",
      tone: "success",
      text: analysis.speech,
      nextStep: "合并分支",
      speak: analysis.speech,
    });
    expect(SessionCardSchema.safeParse(card).success).toBe(true);
  });

  it("labels each status and falls back to summary without speech", () => {
    const { speech: _speech, ...older } = analysis;
    const waiting = readyTurnCard({ ...older, status: "waiting_for_user", nextSteps: [] });
    expect(waiting).toMatchObject({ label: "需要处理", tone: "warning", text: "已完成登录页。", nextStep: null });
    expect(readyTurnCard({ ...analysis, status: "blocked" }).label).toBe("阻塞");
    expect(readyTurnCard({ ...analysis, status: "in_progress" }).label).toBe("进行中");
    expect(readyTurnCard({ ...analysis, status: "unclear" }).label).toBe("不明确");
  });

  it("builds failed and superseded cards", () => {
    expect(failedTurnCard(new Error("分析超时\n多行"))).toMatchObject({
      state: "failed",
      tone: "danger",
      text: "分析失败：分析超时 多行",
    });
    expect(supersededTurnCard()).toMatchObject({ state: "superseded", tone: "muted", text: "已被新一轮取代" });
    expect(shortError("x".repeat(200))).toHaveLength(80);
    expect(shortError(undefined)).toBe("未知错误");
  });
});

describe("permission cards", () => {
  it("shows a tool permission waiting for authorization", () => {
    const card = permissionCard({
      id: "r1",
      kind: "tool",
      name: "Bash",
      title: "运行 npm test",
      description: "在项目根目录执行测试",
      actions: [{ id: "a", label: "允许" }, { id: "b", label: "拒绝" }],
    });
    expect(card).toMatchObject({
      variant: "permission",
      state: "waiting",
      label: "等待授权",
      text: "运行 npm test",
      detail: "在项目根目录执行测试",
      choices: ["允许", "拒绝"],
    });
    expect(SessionCardSchema.safeParse(card).success).toBe(true);
  });

  it("shows a question with its options", () => {
    const request = {
      id: "r2",
      kind: "question",
      name: "AskUserQuestion",
      input: { questions: [{ question: "用哪个数据库？", options: [{ label: "SQLite" }, { label: "Postgres" }] }] },
    };
    const card = permissionCard(request);
    expect(card).toMatchObject({ label: "等待回答", text: "用哪个数据库？", choices: ["SQLite", "Postgres"] });
    expect(permissionSpeech("订单服务", request)).toBe("订单服务：用哪个数据库？，选项：SQLite、Postgres");
  });

  it("speaks a permission as 等待授权", () => {
    expect(permissionSpeech("订单服务", { id: "r", kind: "tool", title: "运行 npm test" })).toBe(
      "订单服务：等待授权：运行 npm test",
    );
  });

  it("rewrites the card when resolved", () => {
    const waiting = permissionCard({ id: "r", kind: "tool", title: "t", actions: [{ id: "a", label: "允许" }] });
    expect(resolvedPermissionCard(waiting, "allow")).toMatchObject({ state: "resolved", label: "已允许", tone: "muted", choices: [] });
    expect(resolvedPermissionCard(waiting, "deny").label).toBe("已拒绝");
    const question = permissionCard({ id: "q", kind: "question", title: "?" });
    expect(resolvedPermissionCard(question, "allow").label).toBe("已回答");
  });
});

describe("sessionDisplayName", () => {
  it("prefers the agent title, then the analysis title, then the folder", () => {
    expect(sessionDisplayName({ agentTitle: " 我的 会话 ", analysisTitle: "x", cwd: "/a/b" })).toBe("我的 会话");
    expect(sessionDisplayName({ agentTitle: null, analysisTitle: "分析标题", cwd: "/a/b" })).toBe("分析标题");
    expect(sessionDisplayName({ agentTitle: null, cwd: "/a/proj/" })).toBe("proj");
    expect(sessionDisplayName({ agentTitle: null, cwd: "/" })).toBe("会话");
  });
});

describe("declared results on turn cards", () => {
  it("takes status from the agent's declaration", () => {
    expect(readyTurnCard(analysis, { kind: "blocked", text: "x" }).label).toBe("阻塞");
    expect(readyTurnCard({ ...analysis, status: "blocked" }, { kind: "done", text: "x" }).label).toBe("已完成");
  });
});
