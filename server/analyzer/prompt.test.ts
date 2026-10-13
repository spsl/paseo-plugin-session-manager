import { describe, expect, it } from "vitest";
import { NOW_MAX_LENGTH, SPEECH_MAX_LENGTH, type Turn } from "../../shared/types";
import { INVARIANT_INSTRUCTIONS, buildAnalysisPrompt, buildAnalysisSchema } from "./prompt";

const turn = (id: string): Turn => ({
  id,
  dedupeKey: id,
  userInput: "in",
  agentOutput: "out",
  outcome: "completed",
  completedAt: 1,
  contextIncomplete: false,
});

function payload(historyTurnId: string | null | undefined) {
  const prompt = buildAnalysisPrompt(
    {
      session: {
        id: "a",
        provider: "codex",
        model: null,
        cwd: "/w",
        branch: null,
        agentTitle: null,
        pendingPermission: false,
        firstUserMessage: null,
      },
      turns: [turn("t1"), turn("t2"), turn("t3")],
      previousAnalysis: null,
      history: ["做完一"],
      historyTurnId,
    },
    {},
    null,
  );
  return JSON.parse(prompt.split("\n").at(-1) ?? "{}") as {
    history: string[];
    turns: { id: string; isNew: boolean }[];
  };
}

describe("analysis prompt", () => {
  it("requires a bounded speech field in the schema", () => {
    const schema = buildAnalysisSchema() as {
      required: string[];
      properties: Record<string, { maxLength?: number }>;
    };
    expect(schema.required).toContain("speech");
    expect(schema.properties.speech.maxLength).toBe(SPEECH_MAX_LENGTH);
  });

  it("requires short done and now fields", () => {
    const schema = buildAnalysisSchema() as {
      required: string[];
      properties: Record<string, { maxLength?: number }>;
    };
    expect(schema.required).toEqual(expect.arrayContaining(["done", "now"]));
    expect(schema.properties.now.maxLength).toBe(NOW_MAX_LENGTH);
  });

  it("marks turns after the history boundary as new and passes the history", () => {
    const later = payload("t1");
    expect(later.history).toEqual(["做完一"]);
    expect(later.turns.map((item) => item.isNew)).toEqual([false, true, true]);
    expect(payload(null).turns.every((item) => item.isNew)).toBe(true);
    expect(payload("pruned").turns.every((item) => item.isNew)).toBe(true);
  });

  it("instructs the model in Chinese about the speech sentence", () => {
    expect(INVARIANT_INSTRUCTIONS).toContain(`speech 必须是一到两句中文，最多 ${SPEECH_MAX_LENGTH} 个字符`);
  });
});
