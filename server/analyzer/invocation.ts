import type { AnalysisConfig, AnalyzerAgent } from "../../shared/analysis-config";
import type { ResolvedCommand } from "../cli";

export type AnalyzerInvocationPaths = {
  schemaPath: string;
  outputPath: string;
};

export type AnalyzerInvocation = {
  program: string;
  args: string[];
  /** Codex writes the validated object here; other adapters return stdout. */
  outputPath?: string;
};

export function buildAnalyzerInvocation(args: {
  config: AnalysisConfig;
  command: ResolvedCommand;
  paths: AnalyzerInvocationPaths;
  schema: Record<string, unknown>;
}): AnalyzerInvocation {
  const { config, command, paths, schema } = args;
  const thinkingArgs = config.thinkingLevel ? effortArgs(config.agent, config.thinkingLevel) : [];

  switch (config.agent) {
    case "claude":
      return {
        program: command.program,
        args: [
          ...command.prefixArgs,
          "-p",
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(schema),
          "--model",
          config.model,
          "--permission-mode",
          "plan",
          "--tools",
          "",
          "--no-session-persistence",
          "--disable-slash-commands",
          ...thinkingArgs,
        ],
      };
    case "pi":
      return {
        program: command.program,
        args: [
          ...command.prefixArgs,
          "--print",
          "--mode",
          "text",
          "--no-session",
          "--no-tools",
          "--no-skills",
          "--no-context-files",
          ...(config.model === "default" ? [] : ["--model", config.model]),
          ...thinkingArgs,
        ],
      };
    case "codex":
      return {
        program: command.program,
        args: [
          ...command.prefixArgs,
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "--color",
          "never",
          "-s",
          "read-only",
          "--model",
          config.model,
          ...thinkingArgs,
          "--output-schema",
          paths.schemaPath,
          "--output-last-message",
          paths.outputPath,
          "-",
        ],
        outputPath: paths.outputPath,
      };
  }
}

function effortArgs(
  agent: AnalyzerAgent,
  level: NonNullable<AnalysisConfig["thinkingLevel"]>,
): string[] {
  switch (agent) {
    case "claude":
      return ["--effort", level];
    case "pi":
      return ["--thinking", level];
    case "codex":
      return ["-c", `model_reasoning_effort=${level}`];
  }
}
