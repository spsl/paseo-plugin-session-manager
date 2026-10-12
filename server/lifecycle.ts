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
  labels?: Readonly<Record<string, string>> | null;
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
    deferredUntil: null,
    deferToQueue: false,
    interruptedAt: null,
    resumeState: "idle",
    resumeError: null,
    titleState: { lastWritten: null, userOwned: false, lastWriteError: null },
    createdAt: isoToMs(agent.createdAt) ?? now,
    updatedAt: isoToMs(agent.updatedAt) ?? now,
    completedAt: null,
    archivedAt: null,
    turns: [],
    firstUserMessage: null,
    firstUserMessageKnown: false,
    analyzedTurnId: null,
    labels: {},
    labelsKnown: false,
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

/** Stores the agent labels on the record; returns whether anything changed. */
export function applyLabels(record: SessionRecord, labels: Readonly<Record<string, string>>): boolean {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    if (typeof value === "string") {
      next[key] = value;
    }
  }
  const keys = Object.keys(next);
  const same =
    record.labelsKnown &&
    keys.length === Object.keys(record.labels).length &&
    keys.every(function matches(key) {
      return record.labels[key] === next[key];
    });
  if (same) {
    return false;
  }
  record.labels = next;
  record.labelsKnown = true;
  return true;
}

export type ApplySnapshotOptions = {
  /**
   * First reconcile after the plugin (re)started: a persisted "live" record
   * whose agent now reports closed went down with the daemon, so it becomes
   * resumable ("dormant") instead of closed.
   */
  dormantOnClosed?: boolean;
};

/** Applies a Paseo snapshot; returns whether anything changed. */
export function applyAgentSnapshot(
  record: SessionRecord,
  agent: SnapshotLike,
  project?: ProjectLike | null,
  options?: ApplySnapshotOptions,
): boolean {
  let changed = applyHookAgent(record, agent);
  const set = <K extends keyof SessionRecord>(key: K, value: SessionRecord[K]): void => {
    if (record[key] !== value) {
      record[key] = value;
      changed = true;
    }
  };
  if (agent.labels) {
    changed = applyLabels(record, agent.labels) || changed;
  }
  const derived = deriveLiveness(agent);
  // A dormant record stays dormant while Paseo still reports the agent closed;
  // any real status (idle/running/error) or an archive takes precedence.
  const liveness =
    derived === "closed" && record.liveness === "dormant"
      ? "dormant"
      : derived === "closed" && options?.dormantOnClosed === true && record.liveness === "live"
        ? "dormant"
        : derived;
  set("liveness", liveness);
  if (liveness === "live") {
    set("resumeState", "idle");
    set("resumeError", null);
  }
  if (liveness === "archived" && record.deferredUntil !== null) {
    record.deferredUntil = null;
    record.deferToQueue = false;
    changed = true;
  }
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
