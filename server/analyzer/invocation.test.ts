import { describe, expect, it } from "vitest";
import type { AnalysisConfig } from "../../shared/analysis-config";
import { tokenizeCommand } from "../cli";
import { buildAnalyzerInvocation } from "./invocation";

const paths = { schemaPath: "/tmp/schema.json", outputPath: "/tmp/result.json" };
const schema = { type: "object" };

function invocation(config: AnalysisConfig, prefixArgs: string[] = [], program?: string) {
  return buildAnalyzerInvocation({
    config,
    command: { program: program ?? config.agent, prefixArgs },
    paths,
    schema,
  });
}

describe("analyzer invocation", () => {
  it("builds a read-only Codex invocation with the selected model and effort", () => {
    expect(invocation({ agent: "codex", model: "gpt-5.6-luna", thinkingLevel: "max" })).toEqual({
      program: "codex",
      args: [
        "exec",
        "--ephemeral",
        "--skip-git-repo-check",
        "--color",
        "never",
        "-s",
        "read-only",
        "--model",
        "gpt-5.6-luna",
        "-c",
        "model_reasoning_effort=max",
        "--output-schema",
        paths.schemaPath,
        "--output-last-message",
        paths.outputPath,
        "-",
      ],
      outputPath: paths.outputPath,
    });
  });

  it("keeps Codex effort optional", () => {
    const result = invocation({ agent: "codex", model: "gpt-5.5", thinkingLevel: null });
    expect(result.args).not.toContain("-c");
  });

  it("builds a no-tools Claude JSON invocation", () => {
    const result = invocation({ agent: "claude", model: "opus", thinkingLevel: "high" });
    expect(result.outputPath).toBeUndefined();
    expect(result.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(schema),
      "--model",
      "opus",
      "--permission-mode",
      "plan",
      "--tools",
      "",
      "--no-session-persistence",
      "--disable-slash-commands",
      "--effort",
      "high",
    ]);
  });

  it("delegates the Pi default model to the CLI configuration", () => {
    const result = invocation({ agent: "pi", model: "default", thinkingLevel: null });
    expect(result.args).not.toContain("--model");
    expect(result.args).toContain("--no-tools");
  });

  it("builds a no-tools Pi invocation and omits a null effort", () => {
    expect(
      invocation({ agent: "pi", model: "github-copilot/gpt-5.4-mini", thinkingLevel: null }),
    ).toEqual({
      program: "pi",
      args: [
        "--print",
        "--mode",
        "text",
        "--no-session",
        "--no-tools",
        "--no-skills",
        "--no-context-files",
        "--model",
        "github-copilot/gpt-5.4-mini",
      ],
    });
  });

  it("puts command prefix args before adapter arguments", () => {
    const [program, ...prefix] = tokenizeCommand("npx --yes claude-wrapper");
    const result = invocation(
      { agent: "claude", model: "sonnet", thinkingLevel: "low" },
      prefix,
      program,
    );
    expect(result.program).toBe("npx");
    expect(result.args.slice(0, 3)).toEqual(["--yes", "claude-wrapper", "-p"]);
  });

  it("rejects malformed command overrides", () => {
    expect(() => tokenizeCommand('"unterminated')).toThrow(/override/i);
    expect(tokenizeCommand("'a b' c\\ d")).toEqual(["a b", "c d"]);
  });
});
