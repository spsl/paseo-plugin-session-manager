import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { ANALYZER_AGENTS } from "./analysis-config";

/** Host-scoped analyzer configuration; the server reads it, the client edits it. */
export const ANALYZER_SETTINGS = defineSettings({
  id: "analyzer",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    agent: z.enum(ANALYZER_AGENTS).default("codex"),
    model: z.string().default("gpt-5.6-luna"),
    thinkingLevel: z.string().default("low"),
    systemPrompt: z.string().default(""),
    /** Executable override; empty means resolve the agent CLI from PATH. */
    command: z.string().default(""),
    concurrency: z.number().int().min(1).max(4).default(2),
    timeoutSeconds: z.number().int().min(30).max(600).default(120),
    writeBackTitle: z.boolean().default(false),
    seedAnalyzeLimit: z.number().int().min(0).max(50).default(10),
    closedRetentionDays: z.number().int().min(1).max(90).default(7),
  }),
});

export type AnalyzerSettings = z.infer<typeof ANALYZER_SETTINGS.schema>;

export const DEFAULT_ANALYZER_SETTINGS: AnalyzerSettings = {
  enabled: true,
  agent: "codex",
  model: "gpt-5.6-luna",
  thinkingLevel: "low",
  systemPrompt: "",
  command: "",
  concurrency: 2,
  timeoutSeconds: 120,
  writeBackTitle: false,
  seedAnalyzeLimit: 10,
  closedRetentionDays: 7,
};
