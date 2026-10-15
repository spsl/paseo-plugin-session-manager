/**
 * Per-turn metadata and digests, plus a log of analyzer calls, in history.db
 * (node:sqlite), next to state.json. The only module touching node:sqlite — still an experimental
 * builtin — so it loads via createRequire inside a try/catch: any failure
 * yields a disabled store instead of breaking the whole plugin load.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import {
  ANALYSIS_RUN_OUTCOMES,
  AnalysisSchema,
  DECLARED_KINDS,
  isAnalysisStatus,
  MAX_ANALYSIS_RUNS,
  type Analysis,
  type AnalysisRun,
  type AnalysisRunOutcome,
  type AnalysisRunSummary,
  type Declared,
  type Turn,
  type TurnOutcome,
  type TurnSubAgent,
} from "../shared/types";

/** Replies at or under this length need no model digest; the raw text is stored. */
export const RAW_DIGEST_MAX_CHARS = 500;
/** Only the head of each turn's user input is kept. */
const USER_INPUT_HEAD_CHARS = 300;

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS turn_digest (
  session_id    TEXT    NOT NULL,
  turn_id       TEXT    NOT NULL,
  dedupe_key    TEXT    NOT NULL,
  completed_at  INTEGER NOT NULL,
  user_input    TEXT,
  outcome       TEXT    NOT NULL,
  edit_count    INTEGER NOT NULL DEFAULT 0,
  declared      TEXT,
  sub_agents    TEXT    NOT NULL DEFAULT '[]',
  step          TEXT,
  digest        TEXT,
  digest_source TEXT,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS turn_digest_by_time ON turn_digest(session_id, completed_at);
CREATE TABLE IF NOT EXISTS analysis_run (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT    NOT NULL,
  turn_id      TEXT    NOT NULL,
  started_at   INTEGER NOT NULL,
  duration_ms  INTEGER NOT NULL,
  user_input   TEXT,
  reanalysis   INTEGER NOT NULL DEFAULT 0,
  agent        TEXT    NOT NULL,
  model        TEXT    NOT NULL,
  input_chars  INTEGER NOT NULL DEFAULT 0,
  new_turns    INTEGER NOT NULL DEFAULT 0,
  digest_count INTEGER NOT NULL DEFAULT 0,
  outcome      TEXT    NOT NULL,
  error        TEXT,
  confidence   REAL,
  status       TEXT,
  result       TEXT
);
CREATE INDEX IF NOT EXISTS analysis_run_by_session ON analysis_run(session_id, id);
PRAGMA user_version = 2;
`;

/** dedupe_key 变化 ⇒ 内容变了 ⇒ step/digest 重置（短回复回落到原文存储）。 */
const UPSERT_SQL = `
INSERT INTO turn_digest (
  session_id, turn_id, dedupe_key, completed_at, user_input, outcome,
  edit_count, declared, sub_agents, step, digest, digest_source, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
ON CONFLICT (session_id, turn_id) DO UPDATE SET
  dedupe_key = excluded.dedupe_key,
  completed_at = excluded.completed_at,
  user_input = excluded.user_input,
  outcome = excluded.outcome,
  edit_count = excluded.edit_count,
  declared = excluded.declared,
  sub_agents = excluded.sub_agents,
  step = CASE WHEN turn_digest.dedupe_key = excluded.dedupe_key THEN turn_digest.step END,
  digest = CASE WHEN turn_digest.dedupe_key = excluded.dedupe_key THEN turn_digest.digest ELSE excluded.digest END,
  digest_source = CASE WHEN turn_digest.dedupe_key = excluded.dedupe_key THEN turn_digest.digest_source ELSE excluded.digest_source END,
  updated_at = excluded.updated_at
`;

const LIST_SQL = `
SELECT turn_id, dedupe_key, completed_at, user_input, outcome, edit_count,
       declared, sub_agents, step, digest, digest_source
FROM turn_digest
WHERE session_id = ?
ORDER BY completed_at, turn_id
`;

const INSERT_RUN_SQL = `
INSERT INTO analysis_run (
  session_id, turn_id, started_at, duration_ms, user_input, reanalysis, agent, model,
  input_chars, new_turns, digest_count, outcome, error, confidence, status, result
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/** Keeps the newest MAX_ANALYSIS_RUNS rows of a session. */
const TRIM_RUNS_SQL = `
DELETE FROM analysis_run
WHERE session_id = ?
  AND id <= (SELECT id FROM analysis_run WHERE session_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)
`;

const RUN_SUMMARY_COLUMNS = `
id, turn_id, started_at, duration_ms, user_input, reanalysis, agent, model,
outcome, error, confidence, status
`;

/** One finished analyzer call; confidence and status are read off `analysis`. */
export type NewAnalysisRun = Omit<AnalysisRun, "id" | "confidence" | "status">;

/** One row of turn_digest, decoded. */
export type TurnDigestRow = {
  turnId: string;
  dedupeKey: string;
  completedAt: number;
  /** First USER_INPUT_HEAD_CHARS chars of the user input. */
  userInput: string | null;
  outcome: TurnOutcome;
  editCount: number;
  declared: Declared | null;
  subAgents: TurnSubAgent[];
  step: string | null;
  digest: string | null;
  digestSource: "model" | "raw" | null;
};

export type DigestStore = {
  /** Insert or replace one ended turn; a dedupe_key change clears step/digest. */
  upsertTurn(
    sessionId: string,
    turn: Turn,
    subAgents: readonly TurnSubAgent[],
    now: number,
  ): void;
  /**
   * Writes the analyzer's step/digest for a turn, only when the row still holds
   * the content the analysis saw (`dedupeKey` matches). An empty digest keeps
   * what's stored; a `raw` row's digest is never overwritten by the model.
   */
  writeAnalysis(
    sessionId: string,
    turnId: string,
    dedupeKey: string,
    step: string,
    digest: string,
    now: number,
  ): void;
  /** Every stored row of a session, oldest first — the flow chart's turn source. */
  listTurns(sessionId: string): TurnDigestRow[];
  /** Logs one analyzer call; only the newest MAX_ANALYSIS_RUNS per session are kept. */
  recordRun(sessionId: string, run: NewAnalysisRun): void;
  /** A session's analyzer calls without their results, newest first. */
  listRuns(sessionId: string): AnalysisRunSummary[];
  getRun(sessionId: string, runId: number): AnalysisRun | null;
  removeSession(sessionId: string): void;
  /** Drops rows of sessions not in `keep` (state.json is the source of truth). */
  pruneOrphans(keep: ReadonlySet<string>): void;
  close(): void;
};

function textOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function declaredOf(value: unknown): Declared | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as { kind?: string; text?: unknown } | null;
    if (
      parsed &&
      typeof parsed.kind === "string" &&
      (DECLARED_KINDS as readonly string[]).includes(parsed.kind) &&
      typeof parsed.text === "string"
    ) {
      return { kind: parsed.kind as Declared["kind"], text: parsed.text };
    }
  } catch {
    // malformed JSON in the column — treat as absent
  }
  return null;
}

function subAgentsOf(value: unknown): TurnSubAgent[] {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: TurnSubAgent[] = [];
    for (const entry of parsed) {
      const item = entry as Record<string, unknown> | null;
      if (!item || typeof item.callId !== "string" || typeof item.status !== "string") {
        continue;
      }
      out.push({
        callId: item.callId,
        type: typeof item.type === "string" ? item.type : "",
        description: typeof item.description === "string" ? item.description : "",
        status: item.status,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function outcomeOf(value: unknown): TurnOutcome {
  return value === "failed" || value === "canceled" ? value : "completed";
}

function rowOf(value: Record<string, unknown>): TurnDigestRow {
  return {
    turnId: String(value.turn_id ?? ""),
    dedupeKey: String(value.dedupe_key ?? ""),
    completedAt: typeof value.completed_at === "number" ? value.completed_at : 0,
    userInput: textOf(value.user_input),
    outcome: outcomeOf(value.outcome),
    editCount: typeof value.edit_count === "number" ? value.edit_count : 0,
    declared: declaredOf(value.declared),
    subAgents: subAgentsOf(value.sub_agents),
    step: textOf(value.step),
    digest: textOf(value.digest),
    digestSource:
      value.digest_source === "model" || value.digest_source === "raw"
        ? value.digest_source
        : null,
  };
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : 0;
}

function runOutcomeOf(value: unknown): AnalysisRunOutcome {
  return typeof value === "string" && (ANALYSIS_RUN_OUTCOMES as readonly string[]).includes(value)
    ? (value as AnalysisRunOutcome)
    : "failed";
}

function analysisOf(value: unknown): Analysis | null {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = AnalysisSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function runSummaryOf(value: Record<string, unknown>): AnalysisRunSummary {
  return {
    id: numberOf(value.id),
    turnId: String(value.turn_id ?? ""),
    startedAt: numberOf(value.started_at),
    durationMs: numberOf(value.duration_ms),
    userInput: textOf(value.user_input),
    reanalysis: numberOf(value.reanalysis) !== 0,
    agent: String(value.agent ?? ""),
    model: String(value.model ?? ""),
    outcome: runOutcomeOf(value.outcome),
    error: textOf(value.error),
    confidence: typeof value.confidence === "number" ? value.confidence : null,
    status: isAnalysisStatus(value.status) ? value.status : null,
  };
}

class SqliteDigestStore implements DigestStore {
  constructor(private readonly db: import("node:sqlite").DatabaseSync) {}

  /** A failed write only warns; the board must keep working without history.db. */
  private guard<T>(what: string, run: () => T, fallback: T): T {
    try {
      return run();
    } catch (error) {
      console.warn(`[session-manager] history.db ${what}失败`, error);
      return fallback;
    }
  }

  upsertTurn(
    sessionId: string,
    turn: Turn,
    subAgents: readonly TurnSubAgent[],
    now: number,
  ): void {
    this.guard(
      "写入轮次",
      () => {
        const raw = turn.agentOutput.length <= RAW_DIGEST_MAX_CHARS ? turn.agentOutput : null;
        this.db.prepare(UPSERT_SQL).run(
          sessionId,
          turn.id,
          turn.dedupeKey,
          turn.completedAt,
          turn.userInput === null ? null : turn.userInput.slice(0, USER_INPUT_HEAD_CHARS),
          turn.outcome,
          turn.editCount ?? 0,
          turn.declared ? JSON.stringify(turn.declared) : null,
          JSON.stringify(subAgents),
          raw,
          raw === null ? null : "raw",
          now,
        );
      },
      undefined,
    );
  }

  writeAnalysis(
    sessionId: string,
    turnId: string,
    dedupeKey: string,
    step: string,
    digest: string,
    now: number,
  ): void {
    this.guard(
      "写回摘要",
      () => {
        const trimmedStep = step.trim() === "" ? null : step.trim();
        this.db
          .prepare(
            "UPDATE turn_digest SET step = ?, updated_at = ? WHERE session_id = ? AND turn_id = ? AND dedupe_key = ?",
          )
          .run(trimmedStep, now, sessionId, turnId, dedupeKey);
        if (digest === "") {
          // needsDigest=false 的轮次：原文已在 upsert 时存为 raw 摘要，只更新 step
          return;
        }
        this.db
          .prepare(
            "UPDATE turn_digest SET digest = ?, digest_source = 'model', updated_at = ? WHERE session_id = ? AND turn_id = ? AND dedupe_key = ? AND digest_source IS NOT 'raw'",
          )
          .run(digest, now, sessionId, turnId, dedupeKey);
      },
      undefined,
    );
  }

  listTurns(sessionId: string): TurnDigestRow[] {
    return this.guard(
      "读取轮次",
      () =>
        this.db
          .prepare(LIST_SQL)
          .all(sessionId)
          .map((row) => rowOf(row as Record<string, unknown>)),
      [],
    );
  }

  recordRun(sessionId: string, run: NewAnalysisRun): void {
    this.guard(
      "写入分析记录",
      () => {
        this.db.prepare(INSERT_RUN_SQL).run(
          sessionId,
          run.turnId,
          run.startedAt,
          run.durationMs,
          run.userInput === null ? null : run.userInput.slice(0, USER_INPUT_HEAD_CHARS),
          run.reanalysis ? 1 : 0,
          run.agent,
          run.model,
          run.inputChars,
          run.newTurns,
          run.digestCount,
          run.outcome,
          run.error,
          run.analysis?.confidence ?? null,
          run.analysis?.status ?? null,
          run.analysis ? JSON.stringify(run.analysis) : null,
        );
        this.db.prepare(TRIM_RUNS_SQL).run(sessionId, sessionId, MAX_ANALYSIS_RUNS);
      },
      undefined,
    );
  }

  listRuns(sessionId: string): AnalysisRunSummary[] {
    return this.guard(
      "读取分析记录",
      () =>
        this.db
          .prepare(
            `SELECT ${RUN_SUMMARY_COLUMNS} FROM analysis_run WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
          )
          .all(sessionId, MAX_ANALYSIS_RUNS)
          .map((row) => runSummaryOf(row as Record<string, unknown>)),
      [],
    );
  }

  getRun(sessionId: string, runId: number): AnalysisRun | null {
    return this.guard(
      "读取分析记录",
      () => {
        const row = this.db
          .prepare(
            `SELECT ${RUN_SUMMARY_COLUMNS}, input_chars, new_turns, digest_count, result FROM analysis_run WHERE session_id = ? AND id = ?`,
          )
          .get(sessionId, runId) as Record<string, unknown> | undefined;
        if (!row) {
          return null;
        }
        return {
          ...runSummaryOf(row),
          inputChars: numberOf(row.input_chars),
          newTurns: numberOf(row.new_turns),
          digestCount: numberOf(row.digest_count),
          analysis: analysisOf(row.result),
        };
      },
      null,
    );
  }

  removeSession(sessionId: string): void {
    this.guard(
      "删除会话行",
      () => {
        this.db.prepare("DELETE FROM turn_digest WHERE session_id = ?").run(sessionId);
        this.db.prepare("DELETE FROM analysis_run WHERE session_id = ?").run(sessionId);
      },
      undefined,
    );
  }

  pruneOrphans(keep: ReadonlySet<string>): void {
    this.guard(
      "清理孤儿行",
      () => {
        const rows = this.db
          .prepare("SELECT session_id FROM turn_digest UNION SELECT session_id FROM analysis_run")
          .all() as Record<string, unknown>[];
        const removeTurns = this.db.prepare("DELETE FROM turn_digest WHERE session_id = ?");
        const removeRuns = this.db.prepare("DELETE FROM analysis_run WHERE session_id = ?");
        for (const row of rows) {
          const id = row.session_id;
          if (typeof id === "string" && !keep.has(id)) {
            removeTurns.run(id);
            removeRuns.run(id);
          }
        }
      },
      undefined,
    );
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }
}

const DISABLED: DigestStore = {
  upsertTurn() {},
  writeAnalysis() {},
  listTurns() {
    return [];
  },
  recordRun() {},
  listRuns() {
    return [];
  },
  getRun() {
    return null;
  },
  removeSession() {},
  pruneOrphans() {},
  close() {},
};

/** Opens history.db and creates the table; returns a no-op store on failure. */
export function openDigestStore(path: string): DigestStore {
  try {
    const require = createRequire(resolve(path));
    const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    db.exec(SCHEMA);
    return new SqliteDigestStore(db);
  } catch (error) {
    console.warn("[session-manager] history.db 不可用，每轮摘要、流程图与分析记录已停用", error);
    return DISABLED;
  }
}
