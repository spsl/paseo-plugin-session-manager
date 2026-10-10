import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ANALYSIS_STATES,
  ANALYSIS_STATUSES,
  LIFECYCLES,
  LIVENESSES,
  TURN_OUTCOMES,
  normalizeTitle,
  type Analysis,
  type AnalysisState,
  type AnalysisStatus,
  type Lifecycle,
  type Liveness,
  type SessionView,
  type TitleState,
  type Turn,
} from "../shared/types";
import { MAX_TEXT_LENGTH, stableTextHash } from "./turns";

export const MAX_SESSIONS = 200;
export const MAX_TURNS_PER_SESSION = 12;
export const PERSIST_DEBOUNCE_MS = 300;
const PERSISTED_STATE_VERSION = 1;

/** Server-side record: the persisted SessionView fields plus analysis inputs. */
export type SessionRecord = Omit<
  SessionView,
  | "turnCount"
  | "lastUserInput"
  | "modelStatus"
  | "effectiveStatus"
  | "column"
  | "needsAttention"
  | "draggable"
> & {
  turns: Turn[];
  firstUserMessage: string | null;
  firstUserMessageKnown: boolean;
  analyzedTurnId: string | null;
  titleState: TitleState;
  /** Agent labels from the last snapshot; only meaningful when `labelsKnown`. */
  labels: Record<string, string>;
  labelsKnown: boolean;
};

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
  return {
    id,
    dedupeKey: boundedText(record.dedupeKey) ?? stableTextHash(`${userInput ?? ""}\0${agentOutput}`),
    userInput,
    agentOutput,
    outcome: oneOf(TURN_OUTCOMES, record.outcome) ?? "completed",
    completedAt,
    contextIncomplete: record.contextIncomplete === true,
  };
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
    titleState: hydrateTitleState(record.titleState),
    createdAt: finiteNumber(record.createdAt) ?? updatedAt,
    updatedAt,
    completedAt: finiteNumber(record.completedAt),
    archivedAt: finiteNumber(record.archivedAt),
    turns,
    firstUserMessage: boundedText(record.firstUserMessage),
    firstUserMessageKnown: record.firstUserMessageKnown === true,
    analyzedTurnId: boundedText(record.analyzedTurnId),
    labels: labels ?? {},
    labelsKnown: labels !== null,
  };
}

export function copyRecord(record: SessionRecord): SessionRecord {
  return {
    ...record,
    turns: record.turns.map((turn) => ({ ...turn })),
    titleState: { ...record.titleState },
    labels: { ...record.labels },
    analysis: record.analysis
      ? {
          ...record.analysis,
          progress: [...record.analysis.progress],
          completed: [...record.analysis.completed],
          nextSteps: [...record.analysis.nextSteps],
          blockers: [...record.analysis.blockers],
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
