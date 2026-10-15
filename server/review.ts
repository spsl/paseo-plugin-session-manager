/**
 * Independent code-review tracking: pure functions only. Facts are written by
 * the service hooks; the phase is derived here at projection time so a missed
 * hook event (e.g. a plugin reload gap) self-heals on the next reconcile.
 */
import type { AnalyzerSettings } from "../shared/settings";
import type { ReviewPhase, ReviewVerdict } from "../shared/types";
import type { SessionRecord } from "./store";

/** Label key the original session puts on review sub-agents (value = request id). */
export const REVIEW_LABEL = "session-manager.review";

/** Label dev-team coordinators/members carry; they already run peer reviews. */
const TEAM_LABEL = "team";

/** The built-in request template; `reviewPrompt` in settings replaces it. */
export const DEFAULT_REVIEW_PROMPT = `【代码审查】请为你刚完成的代码改动发起一次独立代码审查，并在审查结束后复核结果。本轮只审查和复核，不要修复任何问题。

1. 用 Paseo 的 list_profiles 选择合适的代码审查 profile，用 create_agent 创建一个审查子 Agent：background 和 notifyOnFinish 设为 true，labels 加上 session-manager.review={审查标识}。创建后结束本轮，等待完成通知，不要轮询。
2. 审查范围：{审查范围}。给子 Agent 的 prompt 写清审查范围、这次改动要达成的目标、你认为需要重点关注的风险。
3. 告诉子 Agent：可以运行测试和类型检查，也可以新增测试代码来验证发现的问题，新增的测试保留；不要修改业务代码，不要 git commit。报告按 阻断 / 重要 / 建议 分级，编号 B1、I1、S1…，每条给出 file:line、触发场景和证据。
4. 收到审查结果后逐条复核：成立 / 不成立 / 存疑，各附一句理由。复核期间不要修改代码，不要提交。
5. 复核回复的第一行写：「审查复核：成立 X 条，不成立 Y 条，存疑 Z 条」，然后列出逐条结论，最后等我确认要修哪些。`;

/** The records a review phase derivation needs beyond the session itself. */
export interface ReviewLookup {
  /** Find a record by id (e.g. a reviewer child). */
  get(id: string): SessionRecord | undefined;
  /** All records, for the "any session's reviewerIds" checks. */
  all(): Iterable<SessionRecord>;
  settings: AnalyzerSettings;
}

type ReviewScope = AnalyzerSettings["reviewScope"];

/** The 「审查复核：成立 X 条，不成立 Y 条，存疑 Z 条」 counts of one reply line. */
export function parseReviewVerdict(line: string): ReviewVerdict | null {
  const match = /^[*_]*审查复核[*_]*\s*[：:]\s*(.*)$/.exec(line.trim());
  if (!match) {
    return null;
  }
  const rest = match[1];
  const pick = (word: string): number | null => {
    const found = new RegExp(`${word}\\s*(\\d+)\\s*条`).exec(rest);
    return found ? Number.parseInt(found[1], 10) : null;
  };
  const valid = pick("成立");
  const invalid = pick("不成立");
  const unsure = pick("存疑");
  if (valid === null && invalid === null && unsure === null) {
    return null;
  }
  return { valid: valid ?? 0, invalid: invalid ?? 0, unsure: unsure ?? 0 };
}

/** One sentence for the `{审查范围}` placeholder, per the reviewScope setting. */
export function reviewScopeText(scope: ReviewScope, lastReviewHead: string | null): string {
  switch (scope) {
    case "uncommitted":
      return "当前工作区尚未提交的改动（git diff HEAD，含新增文件）";
    case "session":
      return "本会话中你所做的全部代码改动";
    case "since_last_review":
      return lastReviewHead
        ? `自上次代码审查以来的改动（${lastReviewHead.slice(0, 7)}..当前工作区，含未提交改动），以你在本会话中做的改动为准`
        : "本会话中你所做的全部代码改动";
  }
}

export function renderReviewPrompt(
  template: string | null | undefined,
  args: { scope: ReviewScope; requestId: string; lastReviewHead: string | null },
): string {
  const body = template?.trim() || DEFAULT_REVIEW_PROMPT;
  return body
    .replaceAll("{审查范围}", reviewScopeText(args.scope, args.lastReviewHead))
    .replaceAll("{审查标识}", args.requestId);
}

/** edit/write calls in turns after the last reviewed boundary. */
export function unreviewedEditCount(record: SessionRecord): number {
  const through = record.reviewedThroughTurnId;
  const index =
    through === null
      ? -1
      : record.turns.findIndex(function byId(turn) {
          return turn.id === through;
        });
  // index -1 (boundary slid out of the window) → all stored turns count.
  let total = 0;
  for (const turn of record.turns.slice(index + 1)) {
    total += turn.editCount ?? 0;
  }
  return total;
}

/** The session belongs to /dev-team: labeled itself, has a labeled child, or the flow opened it. */
export function isDevTeamSession(record: SessionRecord, records: Iterable<SessionRecord>): boolean {
  if (record.labels["team"] !== undefined) {
    return true;
  }
  if (record.firstUserMessage?.startsWith("/dev-team")) {
    return true;
  }
  for (const other of records) {
    if (other.parentAgentId === record.id && other.labels["team"] !== undefined) {
      return true;
    }
  }
  return false;
}

/** The session is itself a review sub-agent: labeled, or listed as somebody's reviewer. */
export function isReviewerSession(record: SessionRecord, records: Iterable<SessionRecord>): boolean {
  if (record.labels[REVIEW_LABEL] !== undefined) {
    return true;
  }
  for (const other of records) {
    if (other.review?.reviewerIds.includes(record.id)) {
      return true;
    }
  }
  return false;
}

/**
 * The reviewer finished: record gone or not live counts as ended; a live one
 * must not be running/waiting and must show it has run at least one turn
 * (a just-created child reports "idle" before its first turn lands).
 */
export function reviewerFinished(reviewer: SessionRecord | undefined): boolean {
  if (reviewer === undefined || reviewer.liveness !== "live") {
    return true;
  }
  if (reviewer.lifecycle === "working" || reviewer.lifecycle === "waiting_permission") {
    return false;
  }
  if (reviewer.pendingPermissionCount > 0) {
    return false;
  }
  return reviewer.completedAt !== null || reviewer.turns.length > 0;
}

/** Last recorded end time of a reviewer, for the "parent turn started after" check. */
function reviewerEnd(reviewer: SessionRecord | undefined): number {
  return reviewer?.completedAt ?? reviewer?.updatedAt ?? 0;
}

/**
 * A review that still blocks a new request: open, not failed, and none of its
 * reviewers was interrupted by a restart (failed/interrupted are retryable).
 */
export function reviewInProgress(record: SessionRecord, records: Iterable<SessionRecord>): boolean {
  const review = record.review;
  if (review === null || review.closedAt !== null || review.error !== null) {
    return false;
  }
  const byId = new Map<string, SessionRecord>();
  for (const other of records) {
    byId.set(other.id, other);
  }
  return !review.reviewerIds.some(function interrupted(id) {
    return byId.get(id)?.interruptedAt !== null && byId.get(id)?.interruptedAt !== undefined;
  });
}

/**
 * The manual-request checks (hard conditions 2, 5, 6, 7): a human-readable
 * refusal reason, or null when a request may be sent.
 */
export function reviewRequestBlock(
  record: SessionRecord,
  records: Iterable<SessionRecord>,
): string | null {
  if (record.liveness !== "live") {
    return "会话未在运行";
  }
  if (record.lifecycle === "waiting_permission" || record.pendingPermissionCount > 0) {
    return "会话有待处理的授权请求";
  }
  if (record.lifecycle !== "idle") {
    return "会话正在运行，等它空闲后再发起审查";
  }
  if (isDevTeamSession(record, records)) {
    return "该会话属于 /dev-team 流程，自带审查";
  }
  if (isReviewerSession(record, records)) {
    return "审查子 Agent 不能再发起审查";
  }
  if (reviewInProgress(record, records)) {
    return "已有进行中的审查";
  }
  return null;
}

/**
 * Hard + soft conditions for the suggestion/auto trigger. Returns the
 * suggestion reason (possibly null) when a review should be offered, else null.
 */
export function reviewEligibility(
  record: SessionRecord,
  records: Iterable<SessionRecord>,
  settings: Pick<AnalyzerSettings, "reviewTrigger">,
): { reason: string | null } | null {
  if (settings.reviewTrigger === "off") {
    return null;
  }
  if (reviewRequestBlock(record, records) !== null) {
    return null;
  }
  const latest = record.turns.at(-1);
  if (latest === undefined || latest.outcome !== "completed") {
    return null;
  }
  if (record.analyzedTurnId !== latest.id) {
    return null;
  }
  if (record.reviewDismissedTurnId === latest.id) {
    return null;
  }
  if (unreviewedEditCount(record) <= 0) {
    return null;
  }
  const suggestion = record.analysis?.review;
  if (suggestion?.suggested !== true) {
    return null;
  }
  return { reason: suggestion.reason || null };
}

/**
 * The review phase derived from stored facts. `suggested` is returned only when
 * the review is absent/closed and the trigger conditions still hold.
 */
export function reviewPhaseOf(
  record: SessionRecord,
  lookup: ReviewLookup,
  now: number,
): ReviewPhase | null {
  const review = record.review;
  if (review === null || review.closedAt !== null) {
    return reviewEligibility(record, lookup.all(), lookup.settings) === null
      ? null
      : "suggested";
  }
  if (review.error !== null) {
    return "failed";
  }
  const reviewers = review.reviewerIds.map(function byId(id) {
    return lookup.get(id);
  });
  if (
    reviewers.some(function interrupted(reviewer) {
      return reviewer?.interruptedAt !== null && reviewer?.interruptedAt !== undefined;
    })
  ) {
    return "interrupted";
  }
  if (review.verifiedTurnId !== null) {
    return "awaiting_confirmation";
  }
  if (review.reviewerIds.length === 0) {
    if (record.lifecycle === "working" || record.lifecycle === "waiting_permission") {
      return "requested";
    }
    const lastEnd = record.turns.at(-1)?.completedAt ?? record.completedAt ?? 0;
    return lastEnd > review.requestedAt ? "failed" : "requested";
  }
  if (
    reviewers.some(function running(reviewer) {
      return !reviewerFinished(reviewer);
    })
  ) {
    return "reviewing";
  }
  return record.lifecycle === "working" || record.lifecycle === "waiting_permission"
    ? "verifying"
    : "reviewing";
}

/**
 * The verify mark on a parent turn end: every reviewer has ended and this turn
 * completed after them. A verdict line alone does not mark the turn — a second
 * reviewer may still be running (T3); a lost reviewer turn_ended is healed by
 * the next reconcile refreshing its lifecycle instead.
 */
export function reviewTurnVerifies(
  review: NonNullable<SessionRecord["review"]>,
  turn: { id: string; completedAt: number },
  lookup: Pick<ReviewLookup, "get">,
): boolean {
  if (review.reviewerIds.length === 0) {
    return false;
  }
  let lastEnd = 0;
  for (const id of review.reviewerIds) {
    const reviewer = lookup.get(id);
    if (!reviewerFinished(reviewer)) {
      return false;
    }
    lastEnd = Math.max(lastEnd, reviewerEnd(reviewer));
  }
  return turn.completedAt >= lastEnd;
}
