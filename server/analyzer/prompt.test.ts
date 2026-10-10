import { describe, expect, it } from "vitest";
import { SPEECH_MAX_LENGTH } from "../../shared/types";
import { INVARIANT_INSTRUCTIONS, buildAnalysisSchema } from "./prompt";

describe("analysis prompt", () => {
  it("requires a bounded speech field in the schema", () => {
    const schema = buildAnalysisSchema() as {
      required: string[];
      properties: Record<string, { maxLength?: number }>;
    };
    expect(schema.required).toContain("speech");
    expect(schema.properties.speech.maxLength).toBe(SPEECH_MAX_LENGTH);
  });

  it("instructs the model in Chinese about the speech sentence", () => {
    expect(INVARIANT_INSTRUCTIONS).toContain(`speech 必须是一到两句中文，最多 ${SPEECH_MAX_LENGTH} 个字符`);
  });
});
