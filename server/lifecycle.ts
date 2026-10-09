/** Pure mapping from Paseo agent snapshots to session records. */
import type { Lifecycle, Liveness } from "../shared/types";
import type { SessionRecord } from "./store";

/** Structural subset of a Paseo agent snapshot (also satisfied by hook agents). */
export type SnapshotLike = {
  id: string;
  provider: string;
  cwd: string;
  workspaceId?: string | null;
  parentAgentId?: string | null;
  model?: string | null;
  status?: string;
  activeTurn?: unknown;
  pendingPermissions?: readonly unknown[];
  title?: string | null;
  attentionReason?: string | null;
  archivedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type ProjectLike = {
  projectKey?: string | null;
  projectName?: string | null;
  workspaceName?: string | null;
  checkout?: {
    currentBranch?: string | null;
    worktreeRoot?: string | null;
  } | null;
};

export function deriveLiveness(agent: SnapshotLike): Liveness {
  if (agent.archivedAt) {
    return "archived";
  }
  return agent.status === "closed" ? "closed" : "live";
}

export function deriveLifecycle(agent: SnapshotLike): Lifecycle {
  if ((agent.pendingPermissions?.length ?? 0) > 0) {
    return "waiting_permission";
  }
  if (agent.status === "running" || (agent.activeTurn !== undefined && agent.activeTurn !== null)) {
    return "working";
  }
  if (agent.status === "error") {
    return "error";
  }
  if (agent.status === "idle") {
    return "idle";
  }
  return "unknown";
}

function isoToMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function attention(value: string | null | undefined): SessionRecord["attentionReason"] {
  return value === "finished" || value === "error" || value === "permission" ? value : null;
}

export function newRecord(
  agent: SnapshotLike,
  now: number,
  project?: ProjectLike | null,
): SessionRecord {
  const record: SessionRecord = {
    id: agent.id,
    provider: agent.provider,
    model: null,
    cwd: agent.cwd,
    workspaceId: null,
    parentAgentId: null,
    projectKey: null,
    projectName: null,
    workspaceName: null,
    branch: null,
    worktreeRoot: null,
    agentTitle: null,
    lifecycle: "idle",
    liveness: "live",
    pendingPermissionCount: 0,
    attentionReason: null,
    analysisState: "awaiting_output",
    analysis: null,
    analysisError: null,
    manualStatusOverride: null,
    titleState: { lastWritten: null, userOwned: false, lastWriteError: null },
    createdAt: isoToMs(agent.createdAt) ?? now,
    updatedAt: isoToMs(agent.updatedAt) ?? now,
    completedAt: null,
    archivedAt: null,
    turns: [],
    firstUserMessage: null,
    firstUserMessageKnown: false,
    analyzedTurnId: null,
  };
  if (agent.status !== undefined) {
    applyAgentSnapshot(record, agent, project);
  } else {
    applyHookAgent(record, agent);
  }
  return record;
}

/** Fields a lifecycle hook agent carries (no status information). */
export function applyHookAgent(record: SessionRecord, agent: SnapshotLike): boolean {
  let changed = false;
  const set = <K extends keyof SessionRecord>(key: K, value: SessionRecord[K]): void => {
    if (record[key] !== value) {
      record[key] = value;
      changed = true;
    }
  };
  set("provider", agent.provider);
  if (agent.cwd) {
    set("cwd", agent.cwd);
  }
  if (agent.workspaceId !== undefined) {
    set("workspaceId", agent.workspaceId);
  }
  if (agent.parentAgentId !== undefined) {
    set("parentAgentId", agent.parentAgentId);
  }
  if (agent.title !== undefined) {
    set("agentTitle", agent.title?.trim() || null);
  }
  return changed;
}

/** Applies a Paseo snapshot; returns whether anything changed. */
export function applyAgentSnapshot(
  record: SessionRecord,
  agent: SnapshotLike,
  project?: ProjectLike | null,
): boolean {
  let changed = applyHookAgent(record, agent);
  const set = <K extends keyof SessionRecord>(key: K, value: SessionRecord[K]): void => {
    if (record[key] !== value) {
      record[key] = value;
      changed = true;
    }
  };
  set("liveness", deriveLiveness(agent));
  set("lifecycle", deriveLifecycle(agent));
  set("pendingPermissionCount", agent.pendingPermissions?.length ?? 0);
  set("model", agent.model ?? null);
  set("attentionReason", attention(agent.attentionReason));
  set("archivedAt", isoToMs(agent.archivedAt));
  const updatedAt = isoToMs(agent.updatedAt);
  if (updatedAt !== null) {
    set("updatedAt", updatedAt);
  }
  if (project) {
    set("projectKey", project.projectKey ?? null);
    set("projectName", project.projectName ?? null);
    set("workspaceName", project.workspaceName ?? null);
    set("branch", project.checkout?.currentBranch ?? null);
    set("worktreeRoot", project.checkout?.worktreeRoot ?? null);
  }
  return changed;
}
