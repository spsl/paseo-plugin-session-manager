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
    /** Magpie's OpenAI-compatible base URL; empty means the default local proxy. */
    magpieBaseUrl: z.string().default(""),
    /** Optional bearer token for Magpie; the local proxy does not require one. */
    magpieApiKey: z.string().default(""),
    concurrency: z.number().int().min(1).max(4).default(2),
    timeoutSeconds: z.number().int().min(30).max(600).default(120),
    writeBackTitle: z.boolean().default(false),
    seedAnalyzeLimit: z.number().int().min(0).max(50).default(10),
    closedRetentionDays: z.number().int().min(1).max(90).default(7),
    /** Which dormant sessions to resume after a Paseo restart. */
    autoResume: z.enum(["attention", "all", "off"]).default("attention"),
    /**
     * After a Paseo restart, tell a /dev-team coordinator which of its team
     * sub-agents (label `team`) were interrupted, so it resumes the flow.
     */
    teamRecovery: z.enum(["notify", "off"]).default("notify"),
    /** Board column width as a percentage of the width that would fill the screen. */
    columnWidthPercent: z.number().int().min(30).max(500).default(90),
    /** Comma/whitespace separated label keys (or key=value); matching agents are hidden and never analyzed. */
    excludedLabelKeys: z.string().default("herald.role"),
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
  magpieBaseUrl: "",
  magpieApiKey: "",
  concurrency: 2,
  timeoutSeconds: 120,
  writeBackTitle: false,
  seedAnalyzeLimit: 10,
  closedRetentionDays: 7,
  autoResume: "attention",
  teamRecovery: "notify",
  columnWidthPercent: 90,
  excludedLabelKeys: "herald.role",
};
