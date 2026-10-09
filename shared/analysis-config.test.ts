import { describe, expect, it } from "vitest";
import {
  DEFAULT_ANALYSIS_CONFIG,
  getAnalyzerModelOptions,
  getDefaultAnalysisConfig,
  getThinkingLevelOptions,
  normalizeAnalysisConfig,
} from "./analysis-config";

describe("analysis configuration", () => {
  it("keeps the historical Codex configuration as the default", () => {
    expect(DEFAULT_ANALYSIS_CONFIG).toEqual({
      agent: "codex",
      model: "gpt-5.6-luna",
      thinkingLevel: "low",
      systemPrompt: null,
    });
    const copy = normalizeAnalysisConfig(undefined);
    expect(copy).toEqual(DEFAULT_ANALYSIS_CONFIG);
    expect(copy).not.toBe(DEFAULT_ANALYSIS_CONFIG);
    expect(
      normalizeAnalysisConfig({ agent: "codex", model: "gpt-5.6-luna", thinkingLevel: "max" })
        .thinkingLevel,
    ).toBe("max");
  });

  it("normalizes malformed persisted values and bounds model ids", () => {
    const normalized = normalizeAnalysisConfig({
      agent: "not-an-agent",
      model: `  ${"m".repeat(600)}  `,
      thinkingLevel: "not-a-level",
    });
    expect(normalized.agent).toBe("codex");
    expect(normalized.model).toHaveLength(512);
    expect(normalized.thinkingLevel).toBe("low");
  });

  it("selects a safe default for each supported adapter", () => {
    expect(getDefaultAnalysisConfig("codex")).toEqual(DEFAULT_ANALYSIS_CONFIG);
    expect(getDefaultAnalysisConfig("claude")).toMatchObject({
      agent: "claude",
      model: "sonnet",
      thinkingLevel: "low",
    });
    expect(getDefaultAnalysisConfig("pi")).toMatchObject({
      agent: "pi",
      model: "default",
      thinkingLevel: null,
    });
  });

  it("uses the selected model capabilities for thinking levels", () => {
    expect(getThinkingLevelOptions("codex", "gpt-5.6-luna").map(({ id }) => id)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(getThinkingLevelOptions("claude", "haiku")).toEqual([]);
    expect(
      getThinkingLevelOptions("pi", "github-copilot/gpt-5.4-mini").map(({ id }) => id),
    ).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("preserves a valid explicit null effort and accepts dynamic model ids", () => {
    expect(
      normalizeAnalysisConfig({ agent: "claude", model: "account-specific-model", thinkingLevel: null }),
    ).toEqual({
      agent: "claude",
      model: "account-specific-model",
      thinkingLevel: null,
      systemPrompt: null,
    });
    expect(getAnalyzerModelOptions("codex")).toEqual(
      expect.arrayContaining([
        { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
        { id: "gpt-5.5", label: "GPT-5.5" },
      ]),
    );
  });

  it("bounds and preserves a custom business prompt while allowing an empty reset", () => {
    expect(normalizeAnalysisConfig({ systemPrompt: "  请聚焦发布风险。  " }).systemPrompt).toBe(
      "请聚焦发布风险。",
    );
    expect(normalizeAnalysisConfig({ systemPrompt: "x".repeat(9_000) }).systemPrompt).toHaveLength(
      8_000,
    );
    expect(normalizeAnalysisConfig({ systemPrompt: "   " }).systemPrompt).toBeNull();
  });
});
