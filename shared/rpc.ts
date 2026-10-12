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

/** Defer a session's board display; `toQueue` parks it in the deferred column. */
export const deferRpc = defineRpc({
  name: "session-manager.defer",
  input: z.object({
    sessionId: z.string(),
    durationMs: z.number().int().positive().max(30 * 24 * 60 * 60 * 1000),
    toQueue: z.boolean(),
  }),
  output: MutationOutput,
});

export const clearDeferRpc = defineRpc({
  name: "session-manager.clear_defer",
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

/** Resume a dormant session (reconnects the agent Paseo closed on restart). */
export const resumeRpc = defineRpc({
  name: "session-manager.resume",
  input: SessionIdInput,
  output: MutationOutput,
});

/** Mark a dormant session as deliberately closed so it is never auto-resumed. */
export const dismissResumeRpc = defineRpc({
  name: "session-manager.dismiss_resume",
  input: SessionIdInput,
  output: MutationOutput,
});

export const stopAgentRpc = defineRpc({
  name: "session-manager.stop_agent",
  input: SessionIdInput,
  output: MutationOutput,
});

/** The persisted composer draft of one session; `null` when none was saved. */
export const draftGetRpc = defineRpc({
  name: "session-manager.draft.get",
  input: SessionIdInput,
  output: z.object({ draft: z.string().nullable() }),
});

/** `draft` of `null` or blank clears the saved draft. */
export const draftSetRpc = defineRpc({
  name: "session-manager.draft.set",
  input: z.object({ sessionId: z.string(), draft: z.string().nullable() }),
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

/** Server-side mermaid → PNG render; the client draws it with RN <Image>. */
export const mermaidRenderRpc = defineRpc({
  name: "session-manager.mermaid.render",
  input: z.object({
    code: z.string().min(1),
    theme: z.enum(["light", "dark"]).default("light"),
  }),
  output: z.union([
    z.object({ ok: z.literal(true), png: z.string(), width: z.number(), height: z.number() }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
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
