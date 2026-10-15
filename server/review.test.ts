import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ANALYZER_SETTINGS, type AnalyzerSettings } from "../shared/settings";
import type { Analysis, ReviewVerdict } from "../shared/types";
import type { Analyzer } from "./analyzer/analyzer";
import type { TurnEndedEvent } from "./host-types";
import { newRecord } from "./lifecycle";
import {
  REVIEW_LABEL,
  isDevTeamSession,
  isReviewerSession,
  parseReviewVerdict,
  renderReviewPrompt,
  reviewEligibility,
  reviewInProgress,
  reviewPhaseOf,
  reviewRequestBlock,
  reviewScopeText,
  reviewTurnVerifies,
  reviewerFinished,
  unreviewedEditCount,
  type ReviewLookup,
} from "./review";
import { SessionManagerService } from "./service";
import type { SessionRecord, StateStore } from "./store";

// ---- record builders --------------------------------------------------------

function turn(id: string, editCount = 0, completedAt = 5, verdict: ReviewVerdict | null = null) {
  return {
    id,
    dedupeKey: id,
    userInput: "in",
    agentOutput: "out",
    outcome: "completed" as const,
    completedAt,
    contextIncomplete: false,
    declared: null,
    editCount,
    reviewVerdict: verdict,
  };
}

function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    title: "标题",
    summary: "s",
    goal: "g",
    status: "completed",
    progress: [],
    completed: [],
    nextSteps: [],
    blockers: [],
    needsUserAttention: false,
    confidence: 0.9,
    ...overrides,
  };
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    ...newRecord({ id: "s", provider: "codex", cwd: "/w" }, 1),
    liveness: "live",
    lifecycle: "idle",
    ...overrides,
  };
}

const suggested = analysis({ review: { suggested: true, reason: "刚完成了功能改动" } });

function eligibleRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return record({
    turns: [turn("t1", 2)],
    analyzedTurnId: "t1",
    analysis: suggested,
    ...overrides,
  });
}

function lookup(records: SessionRecord[], settings?: Partial<AnalyzerSettings>): ReviewLookup {
  const map = new Map(records.map((entry) => [entry.id, entry]));
  return {
    get: (id) => map.get(id),
    all: () => map.values(),
    settings: { ...DEFAULT_ANALYZER_SETTINGS, ...settings },
  };
}

const ON = { reviewTrigger: "suggest" as const };

// ---- verdict parsing --------------------------------------------------------

describe("parseReviewVerdict", () => {
  it("reads the three counts from a verdict line", () => {
    expect(parseReviewVerdict("审查复核：成立 3 条，不成立 1 条，存疑 2 条")).toEqual({
      valid: 3,
      invalid: 1,
      unsure: 2,
    });
  });

  it("accepts markdown emphasis and half-width colon", () => {
    expect(parseReviewVerdict("**审查复核**: 成立 2 条，不成立 0 条")).toEqual({
      valid: 2,
      invalid: 0,
      unsure: 0,
    });
  });

  it("returns null without any count or marker", () => {
    expect(parseReviewVerdict("审查复核：未发现条目")).toBeNull();
    expect(parseReviewVerdict("成立 2 条")).toBeNull();
    expect(parseReviewVerdict("普通回复")).toBeNull();
  });
});

// ---- prompt rendering -------------------------------------------------------

describe("renderReviewPrompt", () => {
  it("replaces the scope and id placeholders in the default template", () => {
    const text = renderReviewPrompt("", {
      scope: "uncommitted",
      requestId: "rv_abc123",
      lastReviewHead: null,
    });
    expect(text).toContain("session-manager.review=rv_abc123");
    expect(text).toContain(reviewScopeText("uncommitted", null));
    expect(text).toContain("create_agent");
    expect(text).toContain("notifyOnFinish");
    expect(text).toContain("审查复核：成立 X 条");
    expect(text).not.toContain("{审查范围}");
    expect(text).not.toContain("{审查标识}");
  });

  it("honours a custom template and falls back when blank", () => {
    const custom = renderReviewPrompt("请审查 {审查范围}（{审查标识}）", {
      scope: "session",
      requestId: "rv_x",
      lastReviewHead: null,
    });
    expect(custom).toBe(`请审查 ${reviewScopeText("session", null)}（rv_x）`);
    const fallback = renderReviewPrompt("   ", {
      scope: "session",
      requestId: "rv_x",
      lastReviewHead: null,
    });
    expect(fallback).toContain("【代码审查】");
  });

  it("renders since_last_review with and without a baseline head", () => {
    expect(reviewScopeText("since_last_review", "deadbeefcafe")).toContain("deadbee..当前工作区");
    expect(reviewScopeText("since_last_review", null)).toBe(reviewScopeText("session", null));
  });
});

// ---- eligibility ------------------------------------------------------------

describe("reviewEligibility", () => {
  it("requires the trigger to be enabled", () => {
    expect(reviewEligibility(eligibleRecord(), [], { reviewTrigger: "off" })).toBeNull();
    expect(reviewEligibility(eligibleRecord(), [], ON)).toEqual({
      reason: "刚完成了功能改动",
    });
  });

  it("rejects a turn without edits, a failed turn, or a non-analyzed latest turn", () => {
    expect(reviewEligibility(eligibleRecord({ turns: [turn("t1", 0)] }), [], ON)).toBeNull();
    expect(
      reviewEligibility(
        eligibleRecord({ turns: [{ ...turn("t1", 2), outcome: "failed" }] }),
        [],
        ON,
      ),
    ).toBeNull();
    expect(reviewEligibility(eligibleRecord({ analyzedTurnId: "t0" }), [], ON)).toBeNull();
    expect(
      reviewEligibility(
    eligibleRecord({ analysis: analysis() }),
        [],
        ON,
      ),
    ).toBeNull();
    expect(
      reviewEligibility(
        eligibleRecord({ analysis: analysis({ review: { suggested: false, reason: "" } }) }),
        [],
        ON,
      ),
    ).toBeNull();
  });

  it("skips dismissed turns, busy sessions, dev-team sessions and reviewers", () => {
    expect(
      reviewEligibility(eligibleRecord({ reviewDismissedTurnId: "t1" }), [], ON),
    ).toBeNull();
    expect(
      reviewEligibility(eligibleRecord({ lifecycle: "working" }), [], ON),
    ).toBeNull();
    expect(
      reviewEligibility(eligibleRecord({ firstUserMessage: "/dev-team 做需求" }), [], ON),
    ).toBeNull();
    const reviewer = record({ id: "rv1", labels: { [REVIEW_LABEL]: "rv_x" } });
    expect(
      reviewEligibility(
        { ...eligibleRecord({ id: "rv1" }), labels: { [REVIEW_LABEL]: "rv_x" } },
        [reviewer],
        ON,
      ),
    ).toBeNull();
  });

  it("counts edits only after the reviewed boundary", () => {
    const base = eligibleRecord({
      turns: [turn("t0", 3, 4), turn("t1", 2)],
      reviewedThroughTurnId: "t0",
    });
    expect(unreviewedEditCount(base)).toBe(2);
    expect(reviewEligibility(base, [], ON)).not.toBeNull();
    const covered = eligibleRecord({
      turns: [turn("t0", 3, 4), turn("t1", 2)],
      reviewedThroughTurnId: "t1",
    });
    expect(unreviewedEditCount(covered)).toBe(0);
    expect(reviewEligibility(covered, [], ON)).toBeNull();
    // A boundary that slid out of the window counts every stored turn.
    const slid = eligibleRecord({
      turns: [turn("t1", 2)],
      reviewedThroughTurnId: "gone",
    });
    expect(unreviewedEditCount(slid)).toBe(2);
  });

  it("rejects while a review is in progress but allows a failed or closed one", () => {
    const open = eligibleRecord({
      review: {
        id: "rv_1",
        turnId: "t0",
        trigger: "auto",
        requestedAt: 3,
        baseHead: null,
        reviewerIds: ["r1"],
        verifiedTurnId: null,
        verdict: null,
        error: null,
        closedAt: null,
      },
    });
    const running = record({ id: "r1", lifecycle: "working" });
    expect(reviewEligibility(open, [open, running], ON)).toBeNull();
    const failed = eligibleRecord({
      review: { ...open.review!, error: "发送失败" },
    });
    expect(reviewEligibility(failed, [failed], ON)).not.toBeNull();
  });
});

// ---- phase derivation -------------------------------------------------------

describe("reviewPhaseOf", () => {
  const openReview = (overrides = {}) => ({
    id: "rv_1",
    turnId: "t1",
    trigger: "manual" as const,
    requestedAt: 10,
    baseHead: "abc",
    reviewerIds: [] as string[],
    verifiedTurnId: null,
    verdict: null,
    error: null,
    closedAt: null,
    ...overrides,
  });

  it("derives suggested / requested / failed without reviewers", () => {
    expect(reviewPhaseOf(eligibleRecord(), lookup([eligibleRecord()]), 0)).toBe("suggested");
    // Requested, parent working on it.
    const working = record({ lifecycle: "working", review: openReview() });
    expect(reviewPhaseOf(working, lookup([working]), 0)).toBe("requested");
    // Parent went idle and replied without creating a reviewer (T6).
    const noChild = record({
      lifecycle: "idle",
      turns: [turn("t2", 0, 20)],
      review: openReview(),
    });
    expect(reviewPhaseOf(noChild, lookup([noChild]), 0)).toBe("failed");
    // Send failure is stored as an error.
    const failed = record({ lifecycle: "idle", review: openReview({ error: "x" }) });
    expect(reviewPhaseOf(failed, lookup([failed]), 0)).toBe("failed");
  });

  it("derives reviewing / verifying / awaiting_confirmation with reviewers", () => {
    const reviewer = record({ id: "r1", lifecycle: "working" });
    const parent = record({ review: openReview({ reviewerIds: ["r1"] }) });
    expect(reviewPhaseOf(parent, lookup([parent, reviewer]), 0)).toBe("reviewing");
    const done = record({ id: "r1", lifecycle: "idle", completedAt: 30 });
    const verifying = record({ lifecycle: "working", review: openReview({ reviewerIds: ["r1"] }) });
    expect(reviewPhaseOf(verifying, lookup([verifying, done]), 0)).toBe("verifying");
    const verified = record({
      lifecycle: "idle",
      review: openReview({ reviewerIds: ["r1"], verifiedTurnId: "t2" }),
    });
    expect(reviewPhaseOf(verified, lookup([verified, done]), 0)).toBe("awaiting_confirmation");
  });

  it("reports interrupted when any reviewer was cut by a restart (T5)", () => {
    const reviewer = record({ id: "r1", liveness: "dormant", interruptedAt: 99 });
    const parent = record({ review: openReview({ reviewerIds: ["r1"] }) });
    expect(reviewPhaseOf(parent, lookup([parent, reviewer]), 0)).toBe("interrupted");
  });

  it("a closed review falls back to the suggestion or nothing", () => {
    const closed = eligibleRecord({
      review: openReview({ closedAt: 50 }),
      reviewDismissedTurnId: "t1",
    });
    expect(reviewPhaseOf(closed, lookup([closed]), 0)).toBeNull();
    const again = eligibleRecord({ review: openReview({ closedAt: 50 }) });
    expect(reviewPhaseOf(again, lookup([again]), 0)).toBe("suggested");
  });
});

describe("reviewTurnVerifies", () => {
  const base = {
    id: "rv_1",
    turnId: "t1",
    trigger: "manual" as const,
    requestedAt: 10,
    baseHead: null,
    reviewerIds: ["r1"],
    verifiedTurnId: null,
    verdict: null,
    error: null,
    closedAt: null,
  };

  it("requires every reviewer finished and the turn after them (T3)", () => {
    const r1 = record({ id: "r1", lifecycle: "idle", completedAt: 20 });
    const r2 = record({ id: "r2", lifecycle: "working" });
    const review = { ...base, reviewerIds: ["r1", "r2"] };
    const lookupFn = {
      get: (id: string) => ({ r1, r2 })[id as "r1" | "r2"],
    };
    expect(reviewTurnVerifies(review, turn("v", 0, 30), lookupFn)).toBe(false);
    const r2done = record({ id: "r2", lifecycle: "idle", completedAt: 25 });
    expect(
      reviewTurnVerifies(review, turn("v", 0, 30), { get: (id) => ({ r1, r2: r2done })[id] }),
    ).toBe(true);
    // A turn that ended before the reviewer does not count.
    expect(
      reviewTurnVerifies({ ...base }, turn("v", 0, 15), { get: () => r1 }),
    ).toBe(false);
    // No reviewers at all (T6) never verifies.
    expect(reviewTurnVerifies({ ...base, reviewerIds: [] }, turn("v", 0, 30), lookupFn)).toBe(
      false,
    );
    // A deleted reviewer counts as finished.
    expect(reviewTurnVerifies({ ...base }, turn("v", 0, 30), { get: () => undefined })).toBe(true);
  });
});

describe("reviewerFinished / request blocking", () => {
  it("a fresh child is not finished; idle-with-turns is", () => {
    expect(reviewerFinished(undefined)).toBe(true);
    expect(reviewerFinished(record({ lifecycle: "working" }))).toBe(false);
    expect(reviewerFinished(record({ lifecycle: "idle" }))).toBe(false);
    expect(reviewerFinished(record({ lifecycle: "idle", completedAt: 3 }))).toBe(true);
    expect(
      reviewerFinished(record({ lifecycle: "idle", turns: [turn("t")] })),
    ).toBe(true);
    expect(reviewerFinished(record({ liveness: "closed" }))).toBe(true);
  });

  it("reviewRequestBlock only checks live/idle/dev-team/reviewer/in-progress", () => {
    expect(reviewRequestBlock(record({ liveness: "closed" }), [])).toBe("会话未在运行");
    expect(reviewRequestBlock(record({ lifecycle: "working" }), [])).toContain("空闲");
    expect(reviewRequestBlock(record(), [])).toBeNull();
    // No edits needed for a manual request.
    expect(reviewRequestBlock(record({ turns: [] }), [])).toBeNull();
    const tagged = record({ labels: { [REVIEW_LABEL]: "rv_x" } });
    expect(reviewRequestBlock(tagged, [tagged])).toBe("审查子 Agent 不能再发起审查");
  });

  it("isDevTeamSession / isReviewerSession cover labels, children and /dev-team", () => {
    const parent = record({ id: "p" });
    const teamChild = record({ id: "c", parentAgentId: "p", labels: { team: "x" } });
    expect(isDevTeamSession(parent, [parent, teamChild])).toBe(true);
    expect(isDevTeamSession(record({ id: "q" }), [parent, teamChild])).toBe(false);
    const listed = record({ id: "kid" });
    const owner = eligibleRecord({
      id: "p",
      review: {
        id: "rv_1",
        turnId: "t1",
        trigger: "manual",
        requestedAt: 1,
        baseHead: null,
        reviewerIds: ["kid"],
        verifiedTurnId: null,
        verdict: null,
        error: null,
        closedAt: null,
      },
    });
    expect(isReviewerSession(listed, [owner, listed])).toBe(true);
  });
});

// ---- service-level flow -----------------------------------------------------

const agent = (id = "a1", parentAgentId: string | null = null, createdAt?: string) => ({
  id,
  workspaceId: null,
  parentAgentId,
  provider: "codex",
  cwd: "/w",
  title: null,
  ...(createdAt ? { createdAt } : {}),
});

function turnEndedWithEdit(
  turnId: string,
  reply: string,
  id = "a1",
  edits = 1,
): TurnEndedEvent {
  const timeline: unknown[] = [{ type: "user_message", text: "做功能" }];
  for (let index = 0; index < edits; index += 1) {
    timeline.push({ type: "tool_call", detail: { type: "edit" } });
  }
  timeline.push({ type: "assistant_message", text: reply });
  return {
    agent: agent(id),
    turnId,
    outcome: { kind: "completed" },
    timeline,
  } as unknown as TurnEndedEvent;
}

type Send = { id: string; text: string; options?: { activeTurnBehavior?: string } };

function listEntry(id: string, parentAgentId: string | null, labels: Record<string, string> | null) {
  return {
    agent: {
      id,
      provider: "codex",
      cwd: "/w",
      status: "idle",
      title: null,
      labels,
      parentAgentId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    project: null,
  };
}

function fakePaseo(labels: Record<string, Record<string, string>> = {}) {
  const sends: Send[] = [];
  const entries: ReturnType<typeof listEntry>[] = [];
  const paseo = {
    agents: {
      ref: (id: string) => ({
        id,
        refresh: async () => ({
          agent: { id, labels: labels[id] ?? null, parentAgentId: null },
          project: null,
        }),
        send: async (text: string, options?: { activeTurnBehavior?: string }) => {
          sends.push({ id, text, options });
        },
        timeline: {
          refetch: async () => ({ agent: null, entries: [], hasOlder: false }),
        },
      }),
      list: async () => ({ entries, pageInfo: { hasMore: false, nextCursor: null } }),
    },
  };
  // Every onCreated in a test must mirror the agent here or reconcile drops it.
  const add = (id: string, parentAgentId: string | null = null) => {
    entries.push(listEntry(id, parentAgentId, labels[id] ?? null));
  };
  return { paseo: paseo as never, sends, add };
}

function memoryStore(initial: SessionRecord[] = []): StateStore & { saved: number } {
  const store = {
    saved: 0,
    load: async () => initial,
    schedule: () => {
      store.saved += 1;
    },
    flush: async () => undefined,
  };
  return store;
}

function makeService(
  settings: Partial<AnalyzerSettings> = {},
  outcome: Analysis | Error = suggested,
  extraDeps: { headOf?: (cwd: string) => Promise<string | null> } = {},
) {
  const analyzer: Analyzer = {
    analyze: () =>
      outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
  };
  let current: AnalyzerSettings = { ...DEFAULT_ANALYZER_SETTINGS, ...settings };
  const service = new SessionManagerService({
    store: memoryStore(),
    analyzer,
    settings: { current: () => current, refresh: async () => current },
    checkAnalyzer: async () => null,
    writeTitle: vi.fn(async () => undefined),
    headOf: extraDeps.headOf ?? (async () => "deadbeef"),
  });
  return { service, setSettings: (patch: Partial<AnalyzerSettings>) => (current = { ...current, ...patch }) };
}

describe("SessionManagerService review flow", () => {
  it("suggest mode marks the card without sending (T1)", async () => {
    const { service } = makeService({ reviewTrigger: "suggest" });
    const { paseo, sends, add } = fakePaseo();
    service.touchPaseo(paseo);
    add("a1");
    service.onCreated({ agent: agent() });
    service.onTurnEnded(turnEndedWithEdit("t1", "完成：功能做完了"));
    await service.waitForIdle();
    const view = (await service.snapshot()).sessions.find((s) => s.id === "a1");
    expect(view?.review?.phase).toBe("suggested");
    expect(view?.review?.reason).toBe("刚完成了功能改动");
    expect(sends).toHaveLength(0);
  });

  it("no suggestion without edits or when reviewTrigger is off", async () => {
    const noEdit = makeService({ reviewTrigger: "auto" });
    const first = fakePaseo();
    noEdit.service.touchPaseo(first.paseo);
    first.add("a1");
    noEdit.service.onCreated({ agent: agent() });
    noEdit.service.onTurnEnded(turnEndedWithEdit("t1", "只聊了聊", "a1", 0));
    await noEdit.service.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(first.sends).toHaveLength(0);
    expect((await noEdit.service.snapshot()).sessions[0]?.review).toBeNull();
    const off = makeService({ reviewTrigger: "off" });
    const second = fakePaseo();
    off.service.touchPaseo(second.paseo);
    second.add("a1");
    off.service.onCreated({ agent: agent() });
    off.service.onTurnEnded(turnEndedWithEdit("t1", "改了代码"));
    await off.service.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(second.sends).toHaveLength(0);
    expect((await off.service.snapshot()).sessions[0]?.review).toBeNull();
  });

  it("auto mode sends the rendered request with steer (T1)", async () => {
    const { service } = makeService({ reviewTrigger: "auto" });
    const { paseo, sends, add } = fakePaseo();
    service.touchPaseo(paseo);
    add("a1");
    service.onCreated({ agent: agent() });
    service.onTurnEnded(turnEndedWithEdit("t1", "完成：功能做完了"));
    await service.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sends).toHaveLength(1);
    expect(sends[0].options?.activeTurnBehavior).toBe("steer");
    expect(sends[0].text).toContain("【代码审查】");
    const record = service.getRecord("a1");
    expect(record?.review?.trigger).toBe("auto");
    expect(record?.review?.baseHead).toBe("deadbeef");
    expect(record?.reviewedThroughTurnId).toBe("t1");
    expect(record?.lastReviewHead).toBe("deadbeef");
  });

  it("auto mode skips the send when the session got busy meanwhile", async () => {
    let release: (value: Analysis) => void = () => undefined;
    const analyzer: Analyzer = {
      analyze: () => new Promise<Analysis>((resolve) => (release = resolve)),
    };
    let current: AnalyzerSettings = {
      ...DEFAULT_ANALYZER_SETTINGS,
      reviewTrigger: "auto",
    };
    const service = new SessionManagerService({
      store: memoryStore(),
      analyzer,
      settings: { current: () => current, refresh: async () => current },
      checkAnalyzer: async () => null,
      writeTitle: vi.fn(async () => undefined),
      headOf: async () => null,
    });
    const { paseo, sends, add } = fakePaseo();
    service.touchPaseo(paseo);
    add("a1");
    service.onCreated({ agent: agent() });
    service.onTurnEnded(turnEndedWithEdit("t1", "完成：功能做完了"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The session got busy before the analysis finished.
    service.getRecord("a1")!.lifecycle = "working";
    release(suggested);
    await service.waitForIdle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sends).toHaveLength(0);
    expect(service.getRecord("a1")?.review).toBeNull();
    // The auto send was skipped; once the session reads idle again it shows
    // as a suggestion instead of silently sending.
    expect((await service.snapshot()).sessions[0]?.review?.phase).toBe("suggested");
  });

  it("request is idempotent: a second attempt is refused (F3)", async () => {
    const { service } = makeService();
    const { paseo, sends, add } = fakePaseo();
    service.touchPaseo(paseo);
    add("a1");
    service.onCreated({ agent: agent() });
    service.onTurnEnded(turnEndedWithEdit("t1", "完成：功能做完了"));
    await service.waitForIdle();
    expect(await service.requestReview("a1", "请审查")).toEqual({ ok: true });
    const again = await service.requestReview("a1", "请审查");
    expect(again).toEqual({ ok: false, reason: "已有进行中的审查" });
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toBe("请审查");
  });

  it("preview renders the template and request falls back to it", async () => {
    const { service } = makeService({ reviewScope: "uncommitted" });
    const { paseo, sends, add } = fakePaseo();
    service.touchPaseo(paseo);
    add("a1");
    service.onCreated({ agent: agent() });
    service.onTurnEnded(turnEndedWithEdit("t1", "完成：功能做完了"));
    await service.waitForIdle();
    const preview = service.previewReview("a1");
    expect(preview.text).toContain("git diff HEAD");
    expect(preview.text).toMatch(/session-manager\.review=rv_[a-z0-9]+/);
    expect(await service.requestReview("a1")).toEqual({ ok: true });
    expect(sends[0].text).toBe(preview.text);
  });

  it("send failure records a failed review instead of losing it", async () => {
    const { service } = makeService();
    const entries = [listEntry("a1", null, null)];
    const failing = {
      agents: {
        ref: (id: string) => ({
          id,
          refresh: async () => null,
          send: async () => {
            throw new Error("boom");
          },
          timeline: {
            refetch: async () => ({ agent: null, entries: [], hasOlder: false }),
          },
        }),
        list: async () => ({ entries, pageInfo: { hasMore: false } }),
      },
    } as never;
    service.touchPaseo(failing);
    service.onCreated({ agent: agent() });
    service.onTurnEnded(turnEndedWithEdit("t1", "完成：功能做完了"));
    await service.waitForIdle();
    const result = await service.requestReview("a1", "请审查");
    expect(result.ok).toBe(false);
    expect(service.getRecord("a1")?.review?.error).toContain("审查请求发送失败");
    expect((await service.snapshot()).sessions[0]?.review?.phase).toBe("failed");
  });

  it("dismiss suppresses the suggestion for that turn only", async () => {
    const { service } = makeService();
    const { paseo, add } = fakePaseo();
    service.touchPaseo(paseo);
    add("a1");
    service.onCreated({ agent: agent() });
    service.onTurnEnded(turnEndedWithEdit("t1", "完成：功能做完了"));
    await service.waitForIdle();
    const find = async () =>
      (await service.snapshot()).sessions.find((s) => s.id === "a1");
    expect((await find())?.review?.phase).toBe("suggested");
    expect(service.dismissReview("a1")).toEqual({ ok: true });
    expect((await find())?.review).toBeNull();
    // A new turn suggests again.
    service.onTurnEnded(turnEndedWithEdit("t2", "完成：又改了"));
    await service.waitForIdle();
    expect((await find())?.review?.phase).toBe("suggested");
  });

  it("attributes children created while a review is open; a foreign label prunes (T3/F1)", async () => {
    const { service } = makeService();
    const labels: Record<string, Record<string, string>> = {};
    const { paseo, add } = fakePaseo(labels);
    service.touchPaseo(paseo);
    add("a1");
    service.onCreated({ agent: agent() });
    service.onTurnEnded(turnEndedWithEdit("t1", "完成：功能做完了"));
    await service.waitForIdle();
    expect(await service.requestReview("a1", "请审查")).toEqual({ ok: true });
    // Two reviewers created by the parent both join the request.
    add("r1", "a1");
    add("r2", "a1");
    service.onCreated({ agent: agent("r1", "a1") });
    service.onCreated({ agent: agent("r2", "a1") });
    expect(service.getRecord("a1")?.review?.reviewerIds).toEqual(["r1", "r2"]);
    // A probe revealing a foreign review label removes the child.
    labels["r2"] = { [REVIEW_LABEL]: "rv_other" };
    const refetch = (service as never as {
      fetchLabels(p: unknown, id: string): Promise<void>;
    }).fetchLabels(paseo, "r2");
    await refetch;
    expect(service.getRecord("a1")?.review?.reviewerIds).toEqual(["r1"]);
    // The labeled reviewer child itself is never suggested (F1): its own
    // test-writing turn has edits but the review label blocks eligibility.
    labels["r1"] = { [REVIEW_LABEL]: service.getRecord("a1")!.review!.id };
    service.onTurnEnded(turnEndedWithEdit("rt", "完成：写了测试", "r1"));
    await service.waitForIdle();
    const all = [...(service as never as { records: Map<string, SessionRecord> }).records.values()];
    expect(reviewEligibility(service.getRecord("r1")!, all, ON)).toBeNull();
  });

  it("verify needs all reviewers done; the human reply closes (T2/T3)", async () => {
    const { service } = makeService();
    const { paseo, add } = fakePaseo();
    service.touchPaseo(paseo);
    add("a1");
    service.onCreated({ agent: agent() });
    service.onTurnEnded(turnEndedWithEdit("t1", "完成：功能做完了"));
    await service.waitForIdle();
    expect(await service.requestReview("a1", "请审查")).toEqual({ ok: true });
    add("r1", "a1");
    add("r2", "a1");
    service.onCreated({ agent: agent("r1", "a1") });
    service.onCreated({ agent: agent("r2", "a1") });
    // r1 finishes; the parent answers while r2 still runs — no verify yet.
    const r1 = service.getRecord("r1")!;
    r1.lifecycle = "idle";
    r1.completedAt = 100;
    service.onTurnEnded(turnEndedWithEdit("tv", "审查复核：成立 1 条，不成立 0 条，存疑 0 条"));
    await service.waitForIdle();
    expect(service.getRecord("a1")?.review?.verifiedTurnId).toBeNull();
    // r2 finishes; the next parent turn verifies.
    const r2 = service.getRecord("r2")!;
    r2.lifecycle = "idle";
    r2.completedAt = 200;
    service.onTurnEnded(turnEndedWithEdit("tv2", "审查复核：成立 2 条，不成立 1 条，存疑 0 条"));
    await service.waitForIdle();
    const review = service.getRecord("a1")!.review!;
    expect(review.verifiedTurnId).toBe("tv2");
    expect(review.verdict).toEqual({ valid: 2, invalid: 1, unsure: 0 });
    const awaiting = (await service.snapshot()).sessions.find((s) => s.id === "a1");
    expect(awaiting?.review?.phase).toBe("awaiting_confirmation");
    expect(awaiting?.column).toBe("waiting_for_user");
    // The human's reply closes the review.
    service.onTurnStarted({ agent: agent() } as never);
    expect(service.getRecord("a1")?.review?.closedAt).not.toBeNull();
  });

  it("backfills a reviewer created while the plugin was reloading (T4)", async () => {
    const requestedAt = Date.now() - 60_000;
    const parent = record({
      id: "a1",
      review: {
        id: "rv_x",
        turnId: "t1",
        trigger: "auto",
        requestedAt,
        baseHead: null,
        reviewerIds: [],
        verifiedTurnId: null,
        verdict: null,
        error: null,
        closedAt: null,
      },
    });
    const { service } = makeService();
    await service.load();
    (service as never as { records: Map<string, SessionRecord> }).records.set("a1", parent);
    const createdDuringGap = new Date(requestedAt + 10_000).toISOString();
    const paseo = {
      agents: {
        list: async () => ({
          entries: [
            {
              agent: {
                id: "a1",
                provider: "codex",
                cwd: "/w",
                status: "idle",
                title: null,
                labels: null,
                parentAgentId: null,
                createdAt: new Date(requestedAt - 120_000).toISOString(),
                updatedAt: new Date().toISOString(),
              },
              project: null,
            },
            {
              agent: {
                id: "rv-child",
                provider: "claude",
                cwd: "/w",
                status: "working",
                title: null,
                labels: { [REVIEW_LABEL]: "rv_x" },
                parentAgentId: "a1",
                createdAt: createdDuringGap,
                updatedAt: new Date().toISOString(),
              },
              project: null,
            },
            {
              agent: {
                id: "foreign",
                provider: "claude",
                cwd: "/w",
                status: "working",
                title: null,
                labels: { [REVIEW_LABEL]: "rv_other" },
                parentAgentId: "a1",
                createdAt: createdDuringGap,
                updatedAt: new Date().toISOString(),
              },
              project: null,
            },
          ],
          pageInfo: { hasMore: false, nextCursor: null },
        }),
        ref: (id: string) => ({ id, refresh: async () => null }),
      },
    } as never;
    await service.reconcile(paseo);
    expect(parent.review?.reviewerIds).toEqual(["rv-child"]);
  });

  it("an interrupted reviewer marks the phase interrupted (T5)", async () => {
    const { service } = makeService();
    const { paseo, add } = fakePaseo();
    service.touchPaseo(paseo);
    add("a1");
    add("r1", "a1");
    service.onCreated({ agent: agent() });
    service.onTurnEnded(turnEndedWithEdit("t1", "完成：功能做完了"));
    await service.waitForIdle();
    await service.requestReview("a1", "请审查");
    service.onCreated({ agent: agent("r1", "a1") });
    service.getRecord("r1")!.interruptedAt = 5;
    const view = (await service.snapshot()).sessions.find((s) => s.id === "a1");
    expect(view?.review?.phase).toBe("interrupted");
    expect(view?.column).toBe("waiting_for_user");
  });

  it("a verify turn that edited code keeps the changes unreviewed (F2)", async () => {
    const { service } = makeService();
    const { paseo, add } = fakePaseo();
    service.touchPaseo(paseo);
    add("a1");
    add("r1", "a1");
    service.onCreated({ agent: agent() });
    service.onTurnEnded(turnEndedWithEdit("t1", "完成：功能做完了"));
    await service.waitForIdle();
    await service.requestReview("a1", "请审查");
    service.onCreated({ agent: agent("r1", "a1") });
    const r1 = service.getRecord("r1")!;
    r1.lifecycle = "idle";
    r1.completedAt = 100;
    // The verify turn violated the rules and edited files.
    service.onTurnEnded(turnEndedWithEdit("tv", "审查复核：成立 1 条，不成立 0 条，存疑 0 条", "a1", 2));
    await service.waitForIdle();
    const record = service.getRecord("a1")!;
    expect(record.review?.verifiedTurnId).toBe("tv");
    // The boundary stayed at the request turn: the verify edits are unreviewed.
    expect(record.reviewedThroughTurnId).toBe("t1");
    expect(unreviewedEditCount(record)).toBe(2);
    const view = (await service.snapshot()).sessions.find((s) => s.id === "a1");
    expect(view?.review?.editedDuringVerify).toBe(true);
  });
});
