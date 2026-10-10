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

export const LIVENESSES = ["live", "closed", "archived"] as const;
export type Liveness = (typeof LIVENESSES)[number];
export const LivenessSchema = z.enum(LIVENESSES);

export const BOARD_COLUMNS = [
  "unclear",
  "waiting_for_user",
  "in_progress",
  "completed",
  "closed",
] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];
export const BoardColumnSchema = z.enum(BOARD_COLUMNS);

/** Max characters of the one-sentence spoken/card summary. */
export const SPEECH_MAX_LENGTH = 80;

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

export const TurnSchema = z.object({
  id: z.string(),
  /** Stable content key; a turn with the same id OR dedupeKey updates in place. */
  dedupeKey: z.string(),
  userInput: z.string().nullable(),
  agentOutput: z.string(),
  outcome: z.enum(TURN_OUTCOMES),
  completedAt: z.number(),
  contextIncomplete: z.boolean(),
});
export type Turn = z.infer<typeof TurnSchema>;

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
  titleState: TitleStateSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
  archivedAt: z.number().nullable(),
  turnCount: z.number(),
  lastUserInput: z.string().nullable(),
  /** Latest model verdict, without lifecycle or user override applied. */
  modelStatus: AnalysisStatusSchema,
  /** The status the live board presents before the closed column is applied. */
  effectiveStatus: AnalysisStatusSchema,
  column: BoardColumnSchema,
  needsAttention: z.boolean(),
});
export type SessionView = z.infer<typeof SessionViewSchema>;

export const SessionDetailSchema = SessionViewSchema.extend({
  turns: z.array(TurnSchema),
  firstUserMessage: z.string().nullable(),
});
export type SessionDetail = z.infer<typeof SessionDetailSchema>;
