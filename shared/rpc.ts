import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ANALYZER_AGENTS } from "./analysis-config";
import { AnalysisStatusSchema, SessionDetailSchema, SessionViewSchema } from "./types";

const SessionIdInput = z.object({ sessionId: z.string() });
const MutationOutput = z.object({ ok: z.boolean(), reason: z.string().optional() });

export const snapshotRpc = defineRpc({
  name: "session-manager.snapshot",
  input: z.object({}),
  output: z.object({
    generatedAt: z.number(),
    sessions: z.array(SessionViewSchema),
    analyzer: z.object({
      enabled: z.boolean(),
      agent: z.enum(ANALYZER_AGENTS),
      model: z.string(),
      problem: z.string().nullable(),
    }),
    seeding: z.boolean(),
  }),
});

export const detailRpc = defineRpc({
  name: "session-manager.detail",
  input: SessionIdInput,
  output: z.object({ session: SessionDetailSchema.nullable() }),
});

export const reanalyzeRpc = defineRpc({
  name: "session-manager.reanalyze",
  input: SessionIdInput,
  output: MutationOutput,
});

export const setManualStatusRpc = defineRpc({
  name: "session-manager.set_manual_status",
  input: z.object({ sessionId: z.string(), status: AnalysisStatusSchema }),
  output: MutationOutput,
});

export const clearManualStatusRpc = defineRpc({
  name: "session-manager.clear_manual_status",
  input: SessionIdInput,
  output: MutationOutput,
});

export const applyGeneratedTitleRpc = defineRpc({
  name: "session-manager.apply_generated_title",
  input: SessionIdInput,
  output: MutationOutput,
});

export const forgetRpc = defineRpc({
  name: "session-manager.forget",
  input: SessionIdInput,
  output: MutationOutput,
});

export const stopAgentRpc = defineRpc({
  name: "session-manager.stop_agent",
  input: SessionIdInput,
  output: MutationOutput,
});

export const testAnalyzerRpc = defineRpc({
  name: "session-manager.test_analyzer",
  input: z.object({}),
  output: z.object({
    ok: z.boolean(),
    durationMs: z.number(),
    title: z.string().optional(),
    error: z.string().optional(),
  }),
});
