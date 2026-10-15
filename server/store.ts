import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ANALYSIS_STATES,
  ANALYSIS_STATUSES,
  DECLARED_KINDS,
  DECLARED_TEXT_MAX_LENGTH,
  LIFECYCLES,
  LIVENESSES,
  MAX_HISTORY_ENTRIES,
  STEP_MAX_LENGTH,
  TURN_OUTCOMES,
  normalizeTitle,
  type Analysis,
  type AnalysisState,
  type AnalysisStatus,
  type Declared,
  type HistoryEntry,
  type Lifecycle,
  type Liveness,
  type ReviewVerdict,
  type SessionView,
  type TitleState,
  type Turn,
} from "../shared/types";
import { MAX_TEXT_LENGTH, stableTextHash, type TimelineCursor } from "./turns";

export const MAX_SESSIONS = 200;
export const MAX_TURNS_PER_SESSION = 12;
export const MAX_REVIEWERS = 8;
export const PERSIST_DEBOUNCE_MS = 300;
const PERSISTED_STATE_VERSION = 1;

/** Persisted facts of one code-review request; the phase is derived, not stored. */
export type ReviewRecord = {
  /** `rv_<base36>`, also the `session-manager.review` label value. */
  id: string;
  /** The latest turn when the request was sent; its changes count as reviewed. */
  turnId: string;
  trigger: "auto" | "manual";
  requestedAt: number;
  /** `git rev-parse HEAD` at send time; null on non-git directories. */
  baseHead: string | null;
  /** Reviewer sub-agent ids attributed to this request. */
  reviewerIds: string[];
  verifiedTurnId: string | null;
  verdict: ReviewVerdict | null;
  error: string | null;
  /** Set when the human replies after the verdict; kept for the detail pane. */
  closedAt: number | null;
};

/** Server-side record: the persisted SessionView fields plus analysis inputs. */
export type SessionRecord = Omit<
  SessionView,
  | "turnCount"
  | "lastUserInput"
  | "modelStatus"
  | "effectiveStatus"
  | "column"
  | "needsAttention"
  | "deferEndedAt"
  | "declared"
  | "review"
> & {
  /**
   * The `interruptedAt` already reported to the team coordinator, so the
   * same restart is never reported twice (see notifyInterruptedTeams).
   */
  interruptNotifiedAt: number | null;
  turns: Turn[];
  firstUserMessage: string | null;
  firstUserMessageKnown: boolean;
  analyzedTurnId: string | null;
  /** 之前 items accumulated across analyses, oldest first; outlives the turn window. */
  history: HistoryEntry[];
  /**
   * The history boundary the latest analysis used: reanalyzing the same turn
   * reuses it, so the same turns count as new and that turn's items are replaced.
   */
  historyBaseTurnId: string | null;
  titleState: TitleState;
  /** Agent labels from the last snapshot; only meaningful when `labelsKnown`. */
  labels: Record<string, string>;
  labelsKnown: boolean;
  /** The open or most recent code review; null when none was requested. */
  review: ReviewRecord | null;
  /** Turns up to and including this id count as reviewed. */
  reviewedThroughTurnId: string | null;
  /** HEAD at the last successful review request; the since_last_review baseline. */
  lastReviewHead: string | null;
  /** The turn whose review suggestion was dismissed; suppresses a re-suggestion. */
  reviewDismissedTurnId: string | null;
  /** Where ended turns stop in the live timeline; bounds the next turn's slice. */
  timelineCursor: TimelineCursor | null;
};

function hydrateTimelineCursor(value: unknown): TimelineCursor | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const length = finiteNumber(record.length);
  const tailHash = boundedText(record.tailHash);
  if (length === null || !Number.isInteger(length) || length < 0) {
    return null;
  }
  return { length, tailHash: tailHash ?? "" };
}

export type StateStore = {
  load(): Promise<SessionRecord[]>;
  /** Debounced save of whatever `snapshot()` returns when the timer fires. */
  schedule(snapshot: () => readonly SessionRecord[]): void;
  flush(): Promise<void>;
};

export function boundedText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized.slice(0, MAX_TEXT_LENGTH) : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (values as readonly string[]).includes(value)
    ? (value as T)
    : null;
}

function hydrateDeclared(value: unknown): Declared | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind = oneOf(DECLARED_KINDS, record.kind);
  if (!kind || typeof record.text !== "string") {
    return null;
  }
  return { kind, text: record.text.trim().slice(0, DECLARED_TEXT_MAX_LENGTH) };
}

function hydrateVerdict(value: unknown): ReviewVerdict | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const valid = finiteNumber(record.valid);
  const invalid = finiteNumber(record.invalid);
  const unsure = finiteNumber(record.unsure);
  if (valid === null || invalid === null || unsure === null) {
    return null;
  }
  return { valid, invalid, unsure };
}

function hydrateReview(value: unknown): ReviewRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = boundedText(record.id);
  const turnId = boundedText(record.turnId);
  const requestedAt = finiteNumber(record.requestedAt);
  if (!id || !turnId || requestedAt === null) {
    return null;
  }
  return {
    id,
    turnId,
    trigger: record.trigger === "auto" ? "auto" : "manual",
    requestedAt,
    baseHead: boundedText(record.baseHead),
    reviewerIds: (Array.isArray(record.reviewerIds) ? record.reviewerIds : [])
      .map(boundedText)
      .filter((reviewer): reviewer is string => reviewer !== null)
      .slice(0, MAX_REVIEWERS),
    verifiedTurnId: boundedText(record.verifiedTurnId),
    verdict: hydrateVerdict(record.verdict),
    error: boundedText(record.error),
    closedAt: finiteNumber(record.closedAt),
  };
}

function hydrateTurn(value: unknown): Turn | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = boundedText(record.id);
  const agentOutput = boundedText(record.agentOutput);
  const completedAt = finiteNumber(record.completedAt);
  if (!id || !agentOutput || completedAt === null) {
    return null;
  }
  const userInput = boundedText(record.userInput);
  const editCount = finiteNumber(record.editCount);
  return {
    id,
    dedupeKey: boundedText(record.dedupeKey) ?? stableTextHash(`${userInput ?? ""}\0${agentOutput}`),
    userInput,
    agentOutput,
    outcome: oneOf(TURN_OUTCOMES, record.outcome) ?? "completed",
    completedAt,
    contextIncomplete: record.contextIncomplete === true,
    declared: hydrateDeclared(record.declared),
    editCount: editCount === null ? 0 : Math.max(0, Math.floor(editCount)),
    reviewVerdict: hydrateVerdict(record.reviewVerdict),
  };
}

function hydrateHistoryEntry(value: unknown): HistoryEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const turnId = boundedText(record.turnId);
  const at = finiteNumber(record.at);
  const text = boundedText(record.text);
  if (!turnId || at === null || !text) {
    return null;
  }
  return { turnId, at, text: text.slice(0, STEP_MAX_LENGTH) };
}

function hydrateHistory(value: unknown): HistoryEntry[] {
  return (Array.isArray(value) ? value : [])
    .map(hydrateHistoryEntry)
    .filter((entry): entry is HistoryEntry => entry !== null)
    .slice(-MAX_HISTORY_ENTRIES);
}

/** Replaces one turn's 之前 items with `done`; `undefined` (older analyzers) keeps them. */
export function withTurnHistory(
  history: readonly HistoryEntry[],
  turnId: string,
  at: number,
  done: readonly string[] | undefined,
): HistoryEntry[] {
  if (done === undefined) {
    return history.map((entry) => ({ ...entry }));
  }
  const kept = history.filter((entry) => entry.turnId !== turnId);
  const added = done.map((text) => ({ turnId, at, text }));
  return [...kept, ...added].slice(-MAX_HISTORY_ENTRIES);
}

function hydrateAnalysis(value: unknown): Analysis | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const list = (key: string): string[] | null => {
    const items = record[key];
    if (!Array.isArray(items) || items.some((item) => boundedText(item) === null)) {
      return null;
    }
    return items.map((item) => boundedText(item) as string);
  };
  const summary = boundedText(record.summary);
  const speech = boundedText(record.speech);
  const goal = boundedText(record.goal);
  const title = normalizeTitle(record.title) ?? normalizeTitle(goal);
  const status = oneOf(ANALYSIS_STATUSES, record.status);
  const progress = list("progress");
  const completed = list("completed");
  const nextSteps = list("nextSteps");
  const blockers = list("blockers");
  const done = record.done === undefined ? null : list("done");
  const now = boundedText(record.now);
  const confidence = finiteNumber(record.confidence);
  if (
    !summary ||
    !goal ||
    !title ||
    !status ||
    !progress ||
    !completed ||
    !nextSteps ||
    !blockers ||
    typeof record.needsUserAttention !== "boolean" ||
    confidence === null
  ) {
    return null;
  }
  const review =
    record.review && typeof record.review === "object"
      ? (record.review as Record<string, unknown>)
      : null;
  return {
    title,
    summary,
    ...(speech ? { speech } : {}),
    goal,
    status,
    progress,
    completed,
    nextSteps,
    blockers,
    needsUserAttention: record.needsUserAttention,
    confidence: Math.min(1, Math.max(0, confidence)),
    ...(done ? { done } : {}),
    ...(now ? { now } : {}),
    ...(review && typeof review.suggested === "boolean"
      ? { review: { suggested: review.suggested, reason: boundedText(review.reason) ?? "" } }
      : {}),
  };
}

function hydrateTitleState(value: unknown): TitleState {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    lastWritten: boundedText(record.lastWritten),
    userOwned: record.userOwned === true,
    lastWriteError: boundedText(record.lastWriteError),
  };
}

function hydrateLabels(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value as Record<string, unknown>)) {
    if (typeof label === "string") {
      labels[key] = label;
    }
  }
  return labels;
}

export function hydrateRecord(value: unknown): SessionRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = boundedText(record.id);
  const analysisState = oneOf<AnalysisState>(ANALYSIS_STATES, record.analysisState);
  const updatedAt = finiteNumber(record.updatedAt);
  if (!id || !analysisState || updatedAt === null) {
    return null;
  }
  const turns = (Array.isArray(record.turns) ? record.turns : [])
    .map(hydrateTurn)
    .filter((turn): turn is Turn => turn !== null)
    .slice(-MAX_TURNS_PER_SESSION);
  const attention = oneOf(["finished", "error", "permission"] as const, record.attentionReason);
  const manual = oneOf<AnalysisStatus>(ANALYSIS_STATUSES, record.manualStatusOverride);
  const deferredUntil = finiteNumber(record.deferredUntil);
  const labels = record.labelsKnown === true ? hydrateLabels(record.labels) : null;
  return {
    id,
    provider: boundedText(record.provider) ?? "unknown",
    model: boundedText(record.model),
    cwd: boundedText(record.cwd) ?? "",
    workspaceId: boundedText(record.workspaceId),
    parentAgentId: boundedText(record.parentAgentId),
    projectKey: boundedText(record.projectKey),
    projectName: boundedText(record.projectName),
    workspaceName: boundedText(record.workspaceName),
    branch: boundedText(record.branch),
    worktreeRoot: boundedText(record.worktreeRoot),
    agentTitle: boundedText(record.agentTitle),
    lifecycle: oneOf<Lifecycle>(LIFECYCLES, record.lifecycle) ?? "unknown",
    liveness: oneOf<Liveness>(LIVENESSES, record.liveness) ?? "live",
    pendingPermissionCount: Math.max(0, Math.floor(finiteNumber(record.pendingPermissionCount) ?? 0)),
    attentionReason: attention,
    analysisState: analysisState === "running" ? "failed" : analysisState,
    analysis: hydrateAnalysis(record.analysis),
    analysisError:
      analysisState === "running" ? "上次分析在插件重启前中断" : boundedText(record.analysisError),
    manualStatusOverride: manual,
    deferredUntil,
    deferToQueue: deferredUntil !== null && record.deferToQueue === true,
    interruptedAt: finiteNumber(record.interruptedAt),
    interruptNotifiedAt: finiteNumber(record.interruptNotifiedAt),
    // Resume progress is runtime-only: nothing is mid-resume right after a load.
    resumeState: "idle",
    resumeError: null,
    titleState: hydrateTitleState(record.titleState),
    createdAt: finiteNumber(record.createdAt) ?? updatedAt,
    updatedAt,
    completedAt: finiteNumber(record.completedAt),
    archivedAt: finiteNumber(record.archivedAt),
    turns,
    firstUserMessage: boundedText(record.firstUserMessage),
    firstUserMessageKnown: record.firstUserMessageKnown === true,
    analyzedTurnId: boundedText(record.analyzedTurnId),
    history: hydrateHistory(record.history),
    historyBaseTurnId: boundedText(record.historyBaseTurnId),
    labels: labels ?? {},
    labelsKnown: labels !== null,
    review: hydrateReview(record.review),
    reviewedThroughTurnId: boundedText(record.reviewedThroughTurnId),
    lastReviewHead: boundedText(record.lastReviewHead),
    reviewDismissedTurnId: boundedText(record.reviewDismissedTurnId),
    timelineCursor: hydrateTimelineCursor(record.timelineCursor),
  };
}

export function copyRecord(record: SessionRecord): SessionRecord {
  return {
    ...record,
    turns: record.turns.map((turn) => ({
      ...turn,
      ...(turn.reviewVerdict ? { reviewVerdict: { ...turn.reviewVerdict } } : {}),
    })),
    review: record.review
      ? {
          ...record.review,
          reviewerIds: [...record.review.reviewerIds],
          verdict: record.review.verdict ? { ...record.review.verdict } : null,
        }
      : null,
    history: record.history.map((entry) => ({ ...entry })),
    titleState: { ...record.titleState },
    labels: { ...record.labels },
    analysis: record.analysis
      ? {
          ...record.analysis,
          progress: [...record.analysis.progress],
          completed: [...record.analysis.completed],
          nextSteps: [...record.analysis.nextSteps],
          blockers: [...record.analysis.blockers],
          ...(record.analysis.done ? { done: [...record.analysis.done] } : {}),
        }
      : null,
  };
}

export function boundRecords(records: readonly SessionRecord[]): SessionRecord[] {
  return [...records]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_SESSIONS)
    .map((record) => {
      const copy = copyRecord(record);
      copy.turns = copy.turns.slice(-MAX_TURNS_PER_SESSION).map((turn) => ({
        ...turn,
        userInput: turn.userInput === null ? null : turn.userInput.slice(0, MAX_TEXT_LENGTH),
        agentOutput: turn.agentOutput.slice(0, MAX_TEXT_LENGTH),
      }));
      copy.firstUserMessage = copy.firstUserMessage?.slice(0, MAX_TEXT_LENGTH) ?? null;
      copy.history = copy.history.slice(-MAX_HISTORY_ENTRIES);
      if (copy.review) {
        copy.review.reviewerIds = copy.review.reviewerIds.slice(0, MAX_REVIEWERS);
      }
      return copy;
    });
}

/** Persists bounded session history with atomic tmp+rename writes. */
export class JsonStateStore implements StateStore {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: (() => readonly SessionRecord[]) | null = null;
  private loading: Promise<unknown> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private counter = 0;

  constructor(private readonly path: string) {}

  load(): Promise<SessionRecord[]> {
    const promise = this.read();
    this.loading = promise;
    return promise;
  }

  private async read(): Promise<SessionRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as {
        version?: number;
        sessions?: unknown;
      };
      if (parsed?.version !== PERSISTED_STATE_VERSION || !Array.isArray(parsed.sessions)) {
        return [];
      }
      return parsed.sessions
        .map(hydrateRecord)
        .filter((record): record is SessionRecord => record !== null);
    } catch {
      return [];
    }
  }

  async save(records: readonly SessionRecord[]): Promise<void> {
    const directory = dirname(this.path);
    this.counter += 1;
    const temporaryPath = join(directory, `.state-${process.pid}-${Date.now()}-${this.counter}.tmp`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        temporaryPath,
        JSON.stringify({ version: PERSISTED_STATE_VERSION, sessions: boundRecords(records) }),
        { mode: 0o600 },
      );
      await rename(temporaryPath, this.path);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }

  schedule(snapshot: () => readonly SessionRecord[]): void {
    this.pending = snapshot;
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  /** Writes pending changes now; waits for any initial load so it never clobbers state. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const snapshot = this.pending;
    this.pending = null;
    if (!snapshot) {
      await this.writing;
      return;
    }
    const run = async (): Promise<void> => {
      await this.loading?.catch(() => undefined);
      try {
        await this.save(snapshot());
      } catch (error) {
        console.warn("[session-manager] could not persist session history", error);
      }
    };
    this.writing = this.writing.then(run);
    await this.writing;
  }
}
