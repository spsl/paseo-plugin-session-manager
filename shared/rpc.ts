import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ANALYZER_AGENTS } from "./analysis-config";
import { AnnouncementSchema, MAX_SPEECH_CHARS, SpeechVoiceSchema } from "./speech";
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

/** Announcements newer than `since`; `cursor` is the id to pass next time. */
export const announcementsRpc = defineRpc({
  name: "session-manager.announcements",
  input: z.object({ since: z.number().default(0) }),
  output: z.object({
    events: z.array(AnnouncementSchema),
    cursor: z.number(),
  }),
});

export const speechVoicesRpc = defineRpc({
  name: "session-manager.speech.voices",
  input: z.object({}),
  output: z.object({ available: z.boolean(), voices: z.array(SpeechVoiceSchema) }),
});

/** The Magpie proxy's own model catalog, for the direct analyzer settings. */
export const magpieModelsRpc = defineRpc({
  name: "session-manager.magpie.models",
  input: z.object({}),
  output: z.object({
    models: z.array(
      z.object({ id: z.string(), label: z.string(), provider: z.string(), thinking: z.boolean() }),
    ),
    problem: z.string().nullable(),
  }),
});

/** The Pi CLI's own model catalog, so the analyzer settings can offer real ids. */
export const piModelsRpc = defineRpc({
  name: "session-manager.pi.models",
  input: z.object({}),
  output: z.object({
    models: z.array(
      z.object({ id: z.string(), label: z.string(), provider: z.string(), thinking: z.boolean() }),
    ),
    problem: z.string().nullable(),
  }),
});

export const speechRenderRpc = defineRpc({
  name: "session-manager.speech.render",
  input: z.object({
    text: z.string().min(1).max(MAX_SPEECH_CHARS),
    /** A `say` voice name; empty picks the configured/Chinese default. */
    voice: z.string().default(""),
    rate: z.number().min(0.5).max(2).default(1),
  }),
  output: z.object({ mimeType: z.string(), base64: z.string() }),
});
