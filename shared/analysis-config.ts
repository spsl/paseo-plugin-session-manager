/**
 * Analyzer agent / model / thinking-level normalization. Ported from orcb
 * `src/shared/session-observer-analysis.ts` with a static model seed list.
 */

/** Agents with a non-interactive, text-input analysis adapter. */
export const ANALYZER_AGENTS = ["codex", "claude", "pi"] as const;
export type AnalyzerAgent = (typeof ANALYZER_AGENTS)[number];

export type ThinkingLevel =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultra"
  | "on"
  | "off";

export type AnalysisConfig = {
  agent: AnalyzerAgent;
  /** CLI model id. Dynamic provider ids are allowed for forward compatibility. */
  model: string;
  /** null delegates the effort choice to the selected CLI/model. */
  thinkingLevel: ThinkingLevel | null;
  /** Optional user instructions that replace the analyzer's business guidance. */
  systemPrompt?: string | null;
};

export type AnalyzerAgentOption = { id: AnalyzerAgent; label: string };
export type AnalyzerModelOption = { id: string; label: string };
export type ThinkingLevelOption = { id: ThinkingLevel; label: string };

/** The historical observer behavior, made explicit so a new profile is predictable. */
export const DEFAULT_ANALYSIS_CONFIG: AnalysisConfig = {
  agent: "codex",
  model: "gpt-5.6-luna",
  thinkingLevel: "low",
  systemPrompt: null,
};

export const MAX_SYSTEM_PROMPT_LENGTH = 8_000;

const THINKING_LEVEL_ORDER: readonly ThinkingLevel[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];

const AGENT_OPTIONS: readonly AnalyzerAgentOption[] = [
  { id: "codex", label: "Codex" },
  { id: "claude", label: "Claude" },
  { id: "pi", label: "Pi" },
];

const LEVEL_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
  ultra: "Ultra",
};

function levels(ceiling: ThinkingLevel, floor: ThinkingLevel = "minimal"): ThinkingLevelOption[] {
  const from = THINKING_LEVEL_ORDER.indexOf(floor);
  const to = THINKING_LEVEL_ORDER.indexOf(ceiling);
  const result: ThinkingLevelOption[] = [];
  for (let index = from; index <= to; index += 1) {
    const id = THINKING_LEVEL_ORDER[index];
    result.push({ id, label: LEVEL_LABELS[id] });
  }
  return result;
}

type ModelDefinition = AnalyzerModelOption & {
  thinkingLevels: readonly ThinkingLevelOption[];
};

// A small seed. The model field stays editable because accounts and CLI releases
// expose models this plugin cannot know ahead of time.
const MODEL_OPTIONS: Record<AnalyzerAgent, readonly ModelDefinition[]> = {
  codex: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol", thinkingLevels: levels("ultra") },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra", thinkingLevels: levels("ultra") },
    { id: "gpt-5.6-luna", label: "GPT-5.6 Luna", thinkingLevels: levels("max") },
    { id: "gpt-5.5", label: "GPT-5.5", thinkingLevels: levels("xhigh") },
    { id: "gpt-5.2-codex", label: "GPT-5.2 Codex", thinkingLevels: levels("xhigh") },
  ],
  claude: [
    { id: "fable", label: "Fable", thinkingLevels: levels("max", "low") },
    { id: "opus", label: "Opus", thinkingLevels: levels("max", "low") },
    { id: "sonnet", label: "Sonnet", thinkingLevels: levels("max", "low") },
    { id: "haiku", label: "Haiku", thinkingLevels: [] },
  ],
  pi: [{ id: "default", label: "Config default", thinkingLevels: [] }],
};

const THINKING_OPTIONS: Record<AnalyzerAgent, readonly ThinkingLevelOption[]> = {
  codex: levels("ultra"),
  claude: levels("max", "low"),
  pi: levels("xhigh", "low"),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && THINKING_LEVEL_ORDER.includes(value as ThinkingLevel);
}

export function isAnalyzerAgent(value: unknown): value is AnalyzerAgent {
  return typeof value === "string" && (ANALYZER_AGENTS as readonly string[]).includes(value);
}

export function getAnalyzerAgentOptions(): readonly AnalyzerAgentOption[] {
  return AGENT_OPTIONS;
}

export function getAnalyzerModelOptions(agent: AnalyzerAgent): readonly AnalyzerModelOption[] {
  return MODEL_OPTIONS[agent].map(({ id, label }) => ({ id, label }));
}

function defaultModelForAgent(agent: AnalyzerAgent): string {
  if (agent === "claude") {
    return "sonnet";
  }
  return MODEL_OPTIONS[agent][0]?.id ?? DEFAULT_ANALYSIS_CONFIG.model;
}

function defaultThinkingForModel(agent: AnalyzerAgent, model: string): ThinkingLevel | null {
  const options = getThinkingLevelOptions(agent, model);
  if (options.length === 0) {
    return null;
  }
  const low = options.find((option) => option.id === "low");
  return low ? low.id : options[0].id;
}

export function getThinkingLevelOptions(
  agent: AnalyzerAgent,
  model: string,
): readonly ThinkingLevelOption[] {
  const trimmed = model.trim();
  const known = MODEL_OPTIONS[agent].find((option) => option.id === trimmed);
  if (known) {
    return known.thinkingLevels;
  }
  if (agent === "claude" && trimmed.toLowerCase() === "haiku") {
    return [];
  }
  return THINKING_OPTIONS[agent];
}

export function getDefaultAnalysisConfig(agent: AnalyzerAgent): AnalysisConfig {
  const model =
    agent === DEFAULT_ANALYSIS_CONFIG.agent
      ? DEFAULT_ANALYSIS_CONFIG.model
      : defaultModelForAgent(agent);
  return { agent, model, thinkingLevel: defaultThinkingForModel(agent, model), systemPrompt: null };
}

/** Normalizes persisted or RPC-provided values and always returns a fresh object. */
export function normalizeAnalysisConfig(
  value: unknown,
  fallback: AnalysisConfig | undefined = DEFAULT_ANALYSIS_CONFIG,
): AnalysisConfig {
  const fallbackValue = fallback ?? DEFAULT_ANALYSIS_CONFIG;
  const fallbackAgent = isAnalyzerAgent(fallbackValue.agent)
    ? fallbackValue.agent
    : DEFAULT_ANALYSIS_CONFIG.agent;
  const record = isRecord(value) ? value : undefined;
  const requestedAgent = isAnalyzerAgent(record?.agent) ? record.agent : fallbackAgent;
  const fallbackModel =
    typeof fallbackValue.model === "string" && fallbackValue.model.trim().length > 0
      ? fallbackValue.model.trim().slice(0, 512)
      : getDefaultAnalysisConfig(fallbackAgent).model;
  const requestedModel =
    typeof record?.model === "string" && record.model.trim().length > 0
      ? record.model.trim().slice(0, 512)
      : requestedAgent === fallbackAgent
        ? fallbackModel
        : getDefaultAnalysisConfig(requestedAgent).model;
  const model = requestedModel || getDefaultAnalysisConfig(requestedAgent).model;
  const options = getThinkingLevelOptions(requestedAgent, model);
  const requestedThinking =
    record && Object.hasOwn(record, "thinkingLevel")
      ? record.thinkingLevel
      : requestedAgent === fallbackAgent && model === fallbackModel
        ? fallbackValue.thinkingLevel
        : defaultThinkingForModel(requestedAgent, model);
  let thinkingLevel: ThinkingLevel | null;
  if (requestedThinking === null) {
    thinkingLevel = null;
  } else if (
    isThinkingLevel(requestedThinking) &&
    options.some((option) => option.id === requestedThinking)
  ) {
    thinkingLevel = requestedThinking;
  } else {
    thinkingLevel = defaultThinkingForModel(requestedAgent, model);
  }

  const fallbackSystemPrompt =
    typeof fallbackValue.systemPrompt === "string"
      ? fallbackValue.systemPrompt.trim().slice(0, MAX_SYSTEM_PROMPT_LENGTH)
      : null;
  let systemPrompt: string | null;
  if (record && Object.hasOwn(record, "systemPrompt")) {
    systemPrompt =
      typeof record.systemPrompt === "string"
        ? record.systemPrompt.trim().slice(0, MAX_SYSTEM_PROMPT_LENGTH) || null
        : null;
  } else {
    systemPrompt = requestedAgent === fallbackAgent ? fallbackSystemPrompt : null;
  }

  return { agent: requestedAgent, model, thinkingLevel, systemPrompt };
}
