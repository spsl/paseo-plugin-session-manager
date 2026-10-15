/** Pure projection of a session record into the SessionView the board renders. */
import { DEFAULT_ANALYZER_SETTINGS } from "../shared/settings";
import { columnForStatus, firstLine } from "../shared/presentation";
import {
  isActiveLiveness,
  statusForDeclared,
  type AnalysisRunSummary,
  type AnalysisStatus,
  type BoardColumn,
  type ReviewPhase,
  type ReviewView,
  type SessionDetail,
  type SessionView,
} from "../shared/types";
import { reviewEligibility, reviewPhaseOf, type ReviewLookup } from "./review";
import type { SessionRecord } from "./store";

/** Review phases that move the card: running counts as progress, the rest as attention. */
const REVIEW_PROGRESS_PHASES: readonly ReviewPhase[] = ["requested", "reviewing", "verifying"];
const REVIEW_ATTENTION_PHASES: readonly ReviewPhase[] = [
  "awaiting_confirmation",
  "failed",
  "interrupted",
];

export function effectiveStatusOf(
  record: SessionRecord,
  reviewPhase?: ReviewPhase | null,
): AnalysisStatus {
  const live = record.liveness === "live";
  if (isActiveLiveness(record.liveness) && record.manualStatusOverride) {
    return record.manualStatusOverride;
  }
  // A restart-interrupted dormant session always needs the user to look at it.
  if (record.interruptedAt !== null) {
    return "waiting_for_user";
  }
  if (live && record.pendingPermissionCount > 0) {
    return "waiting_for_user";
  }
  if (live && record.lifecycle === "working") {
    return "in_progress";
  }
  // A review underway outranks the model verdict; suggested only adds a badge.
  if (reviewPhase !== undefined && reviewPhase !== null && reviewPhase !== "suggested") {
    if (REVIEW_PROGRESS_PHASES.includes(reviewPhase)) {
      return "in_progress";
    }
    if (REVIEW_ATTENTION_PHASES.includes(reviewPhase)) {
      return "waiting_for_user";
    }
  }
  // The agent's own 「完成 / 阻塞 / 失败」 line beats the model's inference.
  const declared = record.turns.at(-1)?.declared;
  if (declared) {
    return statusForDeclared(declared.kind);
  }
  return record.analysis?.status ?? "unclear";
}

/** A degenerate lookup for callers that cannot see other records (tests, seeds). */
function localLookup(record: SessionRecord): ReviewLookup {
  return {
    get: () => undefined,
    all: function* own() {
      yield record;
    },
    settings: DEFAULT_ANALYZER_SETTINGS,
  };
}

/** The projected review state; null when no phase applies. */
function projectReview(
  record: SessionRecord,
  now: number,
  lookup: ReviewLookup | undefined,
): ReviewView | null {
  const ctx = lookup ?? localLookup(record);
  const phase = reviewPhaseOf(record, ctx, now);
  if (phase === null) {
    return null;
  }
  const review = record.review;
  if (phase === "suggested" || review === null) {
    const eligibility = reviewEligibility(record, ctx.all(), ctx.settings);
    return {
      phase: "suggested",
      requestId: null,
      reason: eligibility?.reason ?? null,
      reviewerIds: [],
      verdict: null,
      editedDuringVerify: false,
      requestedAt: null,
    };
  }
  const verifyTurn = review.verifiedTurnId
    ? record.turns.find(function byId(turn) {
        return turn.id === review.verifiedTurnId;
      })
    : undefined;
  return {
    phase,
    requestId: review.id,
    reason:
      phase === "failed"
        ? (review.error ?? "原会话没有创建审查子 Agent")
        : phase === "interrupted"
          ? "审查子 Agent 被 Paseo 重启中断"
          : null,
    reviewerIds: [...review.reviewerIds],
    verdict: review.verdict,
    editedDuringVerify: (verifyTurn?.editCount ?? 0) > 0,
    requestedAt: review.requestedAt,
  };
}

export function projectView(
  record: SessionRecord,
  now: number = Date.now(),
  lookup?: ReviewLookup,
): SessionView {
  const active = isActiveLiveness(record.liveness);
  const deferred = active && record.deferredUntil !== null && record.deferredUntil > now;
  const review = projectReview(record, now, lookup);
  const effectiveStatus = effectiveStatusOf(record, review?.phase ?? null);
  const column: BoardColumn = !active
    ? "closed"
    : deferred && record.deferToQueue
      ? "deferred"
      : columnForStatus(effectiveStatus);
  const lastTurn = record.turns.at(-1);
  return {
    id: record.id,
    provider: record.provider,
    model: record.model,
    cwd: record.cwd,
    workspaceId: record.workspaceId,
    parentAgentId: record.parentAgentId,
    projectKey: record.projectKey,
    projectName: record.projectName,
    workspaceName: record.workspaceName,
    branch: record.branch,
    worktreeRoot: record.worktreeRoot,
    agentTitle: record.agentTitle,
    lifecycle: record.lifecycle,
    liveness: record.liveness,
    pendingPermissionCount: record.pendingPermissionCount,
    attentionReason: record.attentionReason,
    analysisState: record.analysisState,
    analysis: record.analysis,
    analysisError: record.analysisError,
    manualStatusOverride: record.manualStatusOverride,
    deferredUntil: deferred ? record.deferredUntil : null,
    deferToQueue: deferred ? record.deferToQueue : false,
    // An expired-but-uncleared defer marks a card that just returned to normal
    // display; viewing the card clears it (see SessionManagerService.detail).
    deferEndedAt:
      record.deferredUntil !== null && record.deferredUntil <= now ? record.deferredUntil : null,
    interruptedAt: record.interruptedAt,
    resumeState: record.resumeState,
    resumeError: record.resumeError,
    titleState: { ...record.titleState },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    archivedAt: record.archivedAt,
    turnCount: record.turns.length,
    lastUserInput: firstLine(lastTurn?.userInput ?? null),
    declared: lastTurn?.declared ?? null,
    review,
    modelStatus: record.analysis?.status ?? "unclear",
    effectiveStatus,
    column,
    // Dormant counts too: a restart-closed session in 需要处理 still needs the user.
    needsAttention:
      active &&
      !deferred &&
      (column === "waiting_for_user" || record.pendingPermissionCount > 0),
  };
}

export function projectDetail(
  record: SessionRecord,
  now: number = Date.now(),
  lookup?: ReviewLookup,
  analysisRuns: readonly AnalysisRunSummary[] = [],
): SessionDetail {
  return {
    ...projectView(record, now, lookup),
    turns: record.turns.map((turn) => ({ ...turn })),
    firstUserMessage: record.firstUserMessage,
    history: record.history.map((entry) => ({ ...entry })),
    analysisRuns: analysisRuns.map((run) => ({ ...run })),
  };
}
