/**
 * Core domain types shared by the server and the client. Ported from orcb
 * `src/shared/session-observer.ts`, reshaped around Paseo agents.
 * Pure TS: only zod is imported.
 */
import { z } from "zod";

export const ANALYSIS_STATUSES = [
  "in_progress",
  "waiting_for_user",
  "blocked",
  "completed",
  "unclear",
] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];
export const AnalysisStatusSchema = z.enum(ANALYSIS_STATUSES);

export function isAnalysisStatus(value: unknown): value is AnalysisStatus {
  return typeof value === "string" && (ANALYSIS_STATUSES as readonly string[]).includes(value);
}

export const TITLE_MAX_LENGTH = 48;

/** Normalizes model-generated titles for single-line card and dialog display. */
export function normalizeTitle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, TITLE_MAX_LENGTH) : null;
}

export const ANALYSIS_STATES = ["awaiting_output", "queued", "running", "ready", "failed"] as const;
export type AnalysisState = (typeof ANALYSIS_STATES)[number];
export const AnalysisStateSchema = z.enum(ANALYSIS_STATES);

export const LIFECYCLES = ["working", "waiting_permission", "idle", "error", "unknown"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];
export const LifecycleSchema = z.enum(LIFECYCLES);

export const LIVENESSES = ["live", "dormant", "closed", "archived"] as const;
export type Liveness = (typeof LIVENESSES)[number];
export const LivenessSchema = z.enum(LIVENESSES);

/**
 * "dormant" means closed because Paseo restarted; it is resumable and still
 * counts as an active session on the board. live || dormant.
 */
export function isActiveLiveness(liveness: Liveness): boolean {
  return liveness === "live" || liveness === "dormant";
}

export const RESUME_STATES = ["idle", "queued", "resuming", "failed"] as const;
export type ResumeState = (typeof RESUME_STATES)[number];
export const ResumeStateSchema = z.enum(RESUME_STATES);

export const BOARD_COLUMNS = [
  "unclear",
  "waiting_for_user",
  "in_progress",
  "completed",
  "deferred",
  "closed",
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export const BoardColumnSchema = z.enum(BOARD_COLUMNS);

/** Max characters of the one-sentence spoken/card summary. */
export const SPEECH_MAX_LENGTH = 80;

/** Max characters of one 之前 / 下一步 item. */
export const STEP_MAX_LENGTH = 40;

/** Max characters of the 现在 sentence. */
export const NOW_MAX_LENGTH = 60;

/** Max 之前 items one analysis may add. */
export const MAX_DONE_ITEMS = 3;

/** Max persisted 之前 entries per session. */
export const MAX_HISTORY_ENTRIES = 40;

/** Max characters of one turn's step name on the flow chart. */
export const TURN_STEP_MAX_LENGTH = 30;

/** Max characters kept of one turn's model digest. */
export const TURN_DIGEST_MAX_LENGTH = 600;

/** Step and digest the analyzer returns for one newly analyzed turn. */
export const TurnDigestSchema = z.object({
  turnId: z.string(),
  /** One verb-led line on what the turn did (≤30 chars). */
  step: z.string(),
  /** 300–500 char digest, or "" when the reply is short enough to store raw. */
  digest: z.string(),
});
export type TurnDigest = z.infer<typeof TurnDigestSchema>;

export const AnalysisSchema = z.object({
  /** A concise, model-generated description of the current task. */
  title: z.string(),
  summary: z.string(),
  /** One or two plain Chinese sentences for the card and voice; absent on older persisted analyses. */
  speech: z.string().optional(),
  goal: z.string(),
  status: AnalysisStatusSchema,
  progress: z.array(z.string()),
  completed: z.array(z.string()),
  nextSteps: z.array(z.string()),
  blockers: z.array(z.string()),
  needsUserAttention: z.boolean(),
  confidence: z.number(),
  /** What the newly analyzed turns finished; appended to the session history. Absent on older analyses. */
  done: z.array(z.string()).optional(),
  /** One short sentence on what the session is doing or waiting on. Absent on older analyses. */
  now: z.string().optional(),
  /** The analyzer's review suggestion; absent on older analyses or when reviewTrigger is off. */
  review: z
    .object({
      suggested: z.boolean(),
      reason: z.string(),
    })
    .optional(),
  /** Per-turn step/digest for the newly analyzed turns; absent on older analyses. */
  turnDigests: z.array(TurnDigestSchema).optional(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

/** The sentence to show or speak: `speech`, falling back to `summary` for older analyses. */
export function speechOf(analysis: Pick<Analysis, "speech" | "summary">): string {
  const speech = analysis.speech?.replace(/\s+/g, " ").trim();
  if (speech) {
    return speech;
  }
  return analysis.summary.replace(/\s+/g, " ").trim();
}

export const TURN_OUTCOMES = ["completed", "failed", "canceled"] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

export const DECLARED_KINDS = ["done", "blocked", "failed"] as const;
export type DeclaredKind = (typeof DECLARED_KINDS)[number];

/** Max characters kept from a declared result line. */
export const DECLARED_TEXT_MAX_LENGTH = 200;

/**
 * The status an agent declared itself on the first line of its final reply
 * (「完成：…」「阻塞：…」「失败：…」, the /dev-team reply convention).
 */
export const DeclaredSchema = z.object({
  kind: z.enum(DECLARED_KINDS),
  text: z.string(),
});
export type Declared = z.infer<typeof DeclaredSchema>;

/** Done is completed; blocked and failed both need the user (需要处理). */
export function statusForDeclared(kind: DeclaredKind): AnalysisStatus {
  return kind === "done" ? "completed" : "blocked";
}

export const DECLARED_KIND_LABELS: Record<DeclaredKind, string> = {
  done: "完成",
  blocked: "阻塞",
  failed: "失败",
};

/** Counts from the verify reply's first line (「审查复核：成立 X 条，不成立 Y 条，存疑 Z 条」). */
export const ReviewVerdictSchema = z.object({
  valid: z.number(),
  invalid: z.number(),
  unsure: z.number(),
});
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;

export const REVIEW_PHASES = [
  "suggested",
  "requested",
  "reviewing",
  "verifying",
  "awaiting_confirmation",
  "failed",
  "interrupted",
] as const;
export type ReviewPhase = (typeof REVIEW_PHASES)[number];
export const ReviewPhaseSchema = z.enum(REVIEW_PHASES);

/** The review progress the board shows; null means no review is or was tracked. */
export const ReviewViewSchema = z.object({
  phase: ReviewPhaseSchema,
  /** The request id, also the value of the `session-manager.review` label. */
  requestId: z.string().nullable(),
  /** The suggestion reason, or the failure/interruption reason. */
  reason: z.string().nullable(),
  reviewerIds: z.array(z.string()),
  verdict: ReviewVerdictSchema.nullable(),
  /** The verify turn edited files despite the read-only instruction. */
  editedDuringVerify: z.boolean(),
  requestedAt: z.number().nullable(),
});
export type ReviewView = z.infer<typeof ReviewViewSchema>;

export const TurnSchema = z.object({
  id: z.string(),
  /** Stable content key; a turn with the same id OR dedupeKey updates in place. */
  dedupeKey: z.string(),
  userInput: z.string().nullable(),
  agentOutput: z.string(),
  outcome: z.enum(TURN_OUTCOMES),
  completedAt: z.number(),
  contextIncomplete: z.boolean(),
  /** Absent on turns recorded before declarations were parsed. */
  declared: DeclaredSchema.nullable().optional(),
  /** edit/write tool calls in this turn; absent on older turns means 0. */
  editCount: z.number().optional(),
  /** Parsed 「审查复核：…」 first line; absent on older turns. */
  reviewVerdict: ReviewVerdictSchema.nullable().optional(),
});
export type Turn = z.infer<typeof TurnSchema>;

/** One 之前 item, kept across analyses beyond the stored turn window. */
export const HistoryEntrySchema = z.object({
  /** The turn whose analysis produced it; reanalyzing that turn replaces its items. */
  turnId: z.string(),
  at: z.number(),
  text: z.string(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const TitleStateSchema = z.object({
  /** The last title this plugin wrote to the Paseo agent. */
  lastWritten: z.string().nullable(),
  /** The user renamed the agent; never auto-write again. */
  userOwned: z.boolean(),
  lastWriteError: z.string().nullable(),
});
export type TitleState = z.infer<typeof TitleStateSchema>;

export const ATTENTION_REASONS = ["finished", "error", "permission"] as const;
export const AttentionReasonSchema = z.enum(ATTENTION_REASONS).nullable();
export type AttentionReason = z.infer<typeof AttentionReasonSchema>;

export const SessionViewSchema = z.object({
  id: z.string(),
  provider: z.string(),
  model: z.string().nullable(),
  cwd: z.string(),
  workspaceId: z.string().nullable(),
  parentAgentId: z.string().nullable(),
  projectKey: z.string().nullable(),
  projectName: z.string().nullable(),
  workspaceName: z.string().nullable(),
  branch: z.string().nullable(),
  worktreeRoot: z.string().nullable(),
  /** The agent's own title in Paseo (may be user-chosen). */
  agentTitle: z.string().nullable(),
  lifecycle: LifecycleSchema,
  liveness: LivenessSchema,
  pendingPermissionCount: z.number(),
  attentionReason: AttentionReasonSchema,
  analysisState: AnalysisStateSchema,
  analysis: AnalysisSchema.nullable(),
  analysisError: z.string().nullable(),
  manualStatusOverride: AnalysisStatusSchema.nullable(),
  /** Defer display until this timestamp; null when not deferred. */
  deferredUntil: z.number().nullable(),
  /** A deferred session either sits masked in its column or parks in the deferred queue. */
  deferToQueue: z.boolean(),
  /** The defer ended at this time and the card hasn't been opened since; null otherwise. */
  deferEndedAt: z.number().nullable(),
  /** Set when a Paseo restart closed the session mid-task (working or awaiting permission). */
  interruptedAt: z.number().nullable(),
  /** Runtime resume/reopen progress for dormant and closed sessions; always idle after a reload. */
  resumeState: ResumeStateSchema,
  resumeError: z.string().nullable(),
  titleState: TitleStateSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
  turnCount: z.number(),
  lastUserInput: z.string().nullable(),
  /** The latest turn's self-declared result line, if any. */
  declared: DeclaredSchema.nullable(),
  /** Code-review progress derived from the record; null when nothing applies. */
  review: ReviewViewSchema.nullable(),
  /** Latest model verdict, without lifecycle or user override applied. */
  modelStatus: AnalysisStatusSchema,
  /** The status the live board presents before the closed column is applied. */
  effectiveStatus: AnalysisStatusSchema,
  column: BoardColumnSchema,
  needsAttention: z.boolean(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

/** Max analysis calls kept per session in history.db. */
export const MAX_ANALYSIS_RUNS = 50;

/**
 * What became of one analyzer call: its result was applied, the call failed,
 * a newer turn arrived first, or the session was archived meanwhile.
 */
export const ANALYSIS_RUN_OUTCOMES = ["applied", "failed", "superseded", "discarded"] as const;
export type AnalysisRunOutcome = (typeof ANALYSIS_RUN_OUTCOMES)[number];

/** One analyzer call as listed in the detail pane's 分析记录. */
export const AnalysisRunSummarySchema = z.object({
  id: z.number(),
  /** The last turn the call analyzed. */
  turnId: z.string(),
  startedAt: z.number(),
  durationMs: z.number(),
  /** Head (≤300 chars) of that turn's user input; null when it had none. */
  userInput: z.string().nullable(),
  /** The same turn had been analyzed before (manual 重新分析 or a retry). */
  reanalysis: z.boolean(),
  /** Analyzer agent id (claude / codex / pi / magpie). */
  agent: z.string(),
  model: z.string(),
  outcome: z.enum(ANALYSIS_RUN_OUTCOMES),
  error: z.string().nullable(),
  /** From the model's result; null when the call failed. */
  confidence: z.number().nullable(),
  status: AnalysisStatusSchema.nullable(),
});
export type AnalysisRunSummary = z.infer<typeof AnalysisRunSummarySchema>;

/** One analyzer call with its full result, fetched when a record is opened. */
export const AnalysisRunSchema = AnalysisRunSummarySchema.extend({
  /** JSON length of the analyzer input. */
  inputChars: z.number(),
  /** Turns sent as new (full text). */
  newTurns: z.number(),
  /** Stored turn digests sent along. */
  digestCount: z.number(),
  analysis: AnalysisSchema.nullable(),
});
export type AnalysisRun = z.infer<typeof AnalysisRunSchema>;

export const SessionDetailSchema = SessionViewSchema.extend({
  turns: z.array(TurnSchema),
  firstUserMessage: z.string().nullable(),
  /** 之前 items, oldest first. */
  history: z.array(HistoryEntrySchema),
  /** Analyzer calls, newest first (history.db). */
  analysisRuns: z.array(AnalysisRunSummarySchema),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;

/** One sub_agent tool call spotted inside a turn's timeline. */
export const TurnSubAgentSchema = z.object({
  callId: z.string(),
  /** subAgentType like "Explore"; the tool name when the provider didn't say. */
  type: z.string(),
  /** ≤200 chars. */
  description: z.string(),
  status: z.string(),
});
export type TurnSubAgent = z.infer<typeof TurnSubAgentSchema>;

/** A Paseo child session attached to a turn or to the running tail of the flow chart. */
export const FlowChildSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  /** Board column label, e.g. 已完成. */
  columnLabel: z.string(),
  /** Self-declared result (「完成：…」) or title; null when neither exists yet. */
  detail: z.string().nullable(),
});
export type FlowChild = z.infer<typeof FlowChildSchema>;

/** One turn in the session flow chart and the per-turn digest list under it. */
export const FlowTurnSchema = z.object({
  turnId: z.string(),
  /** 1-based position in the session's turn list. */
  index: z.number(),
  completedAt: z.number(),
  /** User input head (≤300 chars), null when it wasn't captured. */
  userInput: z.string().nullable(),
  step: z.string().nullable(),
  /** First 之前 entry of this turn — the title fallback after `step`. */
  historyLabel: z.string().nullable(),
  digest: z.string().nullable(),
  outcome: z.string(),
  subAgents: z.array(TurnSubAgentSchema),
  /** Paseo child sessions created during this turn. */
  children: z.array(FlowChildSchema),
});
export type FlowTurn = z.infer<typeof FlowTurnSchema>;
