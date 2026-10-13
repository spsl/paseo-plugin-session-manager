/** Pure projection of a session record into the SessionView the board renders. */
import { columnForStatus, firstLine } from "../shared/presentation";
import {
  isActiveLiveness,
  statusForDeclared,
  type AnalysisStatus,
  type BoardColumn,
  type SessionDetail,
  type SessionView,
} from "../shared/types";
import type { SessionRecord } from "./store";

export function effectiveStatusOf(record: SessionRecord): AnalysisStatus {
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
  // The agent's own 「完成 / 阻塞 / 失败」 line beats the model's inference.
  const declared = record.turns.at(-1)?.declared;
  if (declared) {
    return statusForDeclared(declared.kind);
  }
  return record.analysis?.status ?? "unclear";
}

export function projectView(record: SessionRecord, now: number = Date.now()): SessionView {
  const active = isActiveLiveness(record.liveness);
  const deferred = active && record.deferredUntil !== null && record.deferredUntil > now;
  const effectiveStatus = effectiveStatusOf(record);
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

export function projectDetail(record: SessionRecord, now: number = Date.now()): SessionDetail {
  return {
    ...projectView(record, now),
    turns: record.turns.map((turn) => ({ ...turn })),
    firstUserMessage: record.firstUserMessage,
  };
}
