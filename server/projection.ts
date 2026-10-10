/** Pure projection of a session record into the SessionView the board renders. */
import { columnForStatus, firstLine } from "../shared/presentation";
import type { AnalysisStatus, BoardColumn, SessionDetail, SessionView } from "../shared/types";
import type { SessionRecord } from "./store";

export function effectiveStatusOf(record: SessionRecord): AnalysisStatus {
  const live = record.liveness === "live";
  if (live && record.manualStatusOverride) {
    return record.manualStatusOverride;
  }
  if (live && record.pendingPermissionCount > 0) {
    return "waiting_for_user";
  }
  if (live && record.lifecycle === "working") {
    return "in_progress";
  }
  return record.analysis?.status ?? "unclear";
}

export function projectView(record: SessionRecord): SessionView {
  const live = record.liveness === "live";
  const effectiveStatus = effectiveStatusOf(record);
  const column: BoardColumn = live ? columnForStatus(effectiveStatus) : "closed";
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
    titleState: { ...record.titleState },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt,
    archivedAt: record.archivedAt,
    turnCount: record.turns.length,
    lastUserInput: firstLine(lastTurn?.userInput ?? null),
    modelStatus: record.analysis?.status ?? "unclear",
    effectiveStatus,
    column,
    needsAttention: live && (column === "waiting_for_user" || record.pendingPermissionCount > 0),
  };
}

export function projectDetail(record: SessionRecord): SessionDetail {
  return {
    ...projectView(record),
    turns: record.turns.map((turn) => ({ ...turn })),
    firstUserMessage: record.firstUserMessage,
  };
}
