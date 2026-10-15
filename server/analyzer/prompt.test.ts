import { describe, expect, it } from "vitest";
import {
  NOW_MAX_LENGTH,
  SPEECH_MAX_LENGTH,
  TURN_STEP_MAX_LENGTH,
  type Turn,
} from "../../shared/types";
import {
  INVARIANT_INSTRUCTIONS,
  MAX_DIGEST_INPUT_CHARS,
  buildAnalysisPrompt,
  buildAnalysisSchema,
  newTurnIds,
  type AnalyzerTurnDigest,
} from "./prompt";
import { RAW_DIGEST_MAX_CHARS } from "../digest-store";

const turn = (id: string, output = "out"): Turn => ({
  id,
  dedupeKey: id,
  userInput: "in",
  agentOutput: output,
  outcome: "completed",
  completedAt: 1,
  contextIncomplete: false,
});

const digest = (id: string, text = `摘要-${id}`): AnalyzerTurnDigest => ({
  id,
  completedAt: 1,
  userInput: `输入-${id}`,
  step: `步骤-${id}`,
  digest: text,
});

type PayloadTurn = {
  id: string;
  isNew: boolean;
  userInput?: string | null;
  agentOutput?: string;
  step?: string | null;
  digest?: string;
  needsDigest?: boolean;
};

function buildPayload(
  historyTurnId: string | null | undefined,
  turns: Turn[] = [turn("t1"), turn("t2"), turn("t3")],
  digests: AnalyzerTurnDigest[] = [],
) {
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
      turns,
      digests,
      previousAnalysis: null,
      history: ["做完一"],
      historyTurnId,
    },
    {},
    null,
  );
  return JSON.parse(prompt.split("\n").at(-1) ?? "{}") as {
    history: string[];
    turns: PayloadTurn[];
  };
}

function payload(historyTurnId: string | null | undefined) {
  return buildPayload(historyTurnId);
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

  it("adds the review field and rule only when the trigger is on", () => {
    const withReview = buildAnalysisSchema(true) as {
      required: string[];
      properties: Record<string, { required?: string[] }>;
    };
    expect(withReview.required).toContain("review");
    expect(withReview.properties.review.required).toEqual(
      expect.arrayContaining(["suggested", "reason"]),
    );
    const without = buildAnalysisSchema(false) as { required: string[]; properties: object };
    expect(without.required).not.toContain("review");
    expect("review" in without.properties).toBe(false);

    const input = {
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
      turns: [turn("t1")],
      previousAnalysis: null,
    };
    const on = buildAnalysisPrompt(input, buildAnalysisSchema(true), null, true);
    const off = buildAnalysisPrompt(input, buildAnalysisSchema(false), null, false);
    expect(on).toContain("review.suggested");
    expect(off).not.toContain("review.suggested");
    // editCount is always passed so the model can weigh real file changes.
    expect(JSON.parse(on.split("\n").at(-1) ?? "{}").turns[0].editCount).toBe(0);
  });
});

describe("analysis prompt digests", () => {
  it("requires turnDigests with bounded step and digest fields", () => {
    const schema = buildAnalysisSchema() as {
      required: string[];
      properties: {
        turnDigests: {
          items: { required: string[]; properties: Record<string, { maxLength?: number }> };
        };
      };
    };
    expect(schema.required).toContain("turnDigests");
    expect(schema.properties.turnDigests.items.required).toEqual(
      expect.arrayContaining(["turnId", "step", "digest"]),
    );
    expect(schema.properties.turnDigests.items.properties.step.maxLength).toBe(
      TURN_STEP_MAX_LENGTH,
    );
  });

  it("sends earlier turns as digests and new turns in full with needsDigest", () => {
    const turns = [turn("t1"), turn("t2"), turn("t3", "长".repeat(RAW_DIGEST_MAX_CHARS + 1))];
    const body = buildPayload("t1", turns, [digest("t0"), digest("t1")]);
    expect(body.turns.map((item) => item.id)).toEqual(["t0", "t1", "t2", "t3"]);
    // t0 slid out of the window: digest only.
    expect(body.turns[0]).toMatchObject({ isNew: false, step: "步骤-t0", digest: "摘要-t0" });
    expect(body.turns[0].agentOutput).toBeUndefined();
    // t1 is inside the window and has a digest: digest only.
    expect(body.turns[1]).toMatchObject({ isNew: false, step: "步骤-t1", digest: "摘要-t1" });
    expect(body.turns[1].agentOutput).toBeUndefined();
    // t2/t3 are new: full text; the long reply asks for a model digest.
    expect(body.turns[2]).toMatchObject({ isNew: true, agentOutput: "out", needsDigest: false });
    expect(body.turns[3].needsDigest).toBe(true);
    expect(body.turns[3].agentOutput?.length).toBe(RAW_DIGEST_MAX_CHARS + 1);
  });

  it("keeps full text for old turns that have no digest", () => {
    const body = buildPayload("t1", [turn("t1"), turn("t2")], [digest("t1")]);
    expect(body.turns.map((item) => item.id)).toEqual(["t1", "t2"]);
    expect(body.turns[0].digest).toBe("摘要-t1");
    // t2 is isNew here — use a boundary where it isn't.
    const older = buildPayload("t2", [turn("t2"), turn("t3")], []);
    expect(older.turns[0]).toMatchObject({ isNew: false, agentOutput: "out" });
    expect(older.turns[0].digest).toBeUndefined();
  });

  it("does not double-send a new turn that already has a digest row", () => {
    const body = buildPayload(null, [turn("t1")], [digest("t1")]);
    expect(body.turns).toHaveLength(1);
    expect(body.turns[0].isNew).toBe(true);
    expect(body.turns[0].agentOutput).toBe("out");
  });

  it("drops the oldest digests when the total exceeds the cap", () => {
    const big = "摘".repeat(2_000);
    const digests = Array.from({ length: 30 }, (_, index) => digest(`t${index}`, big));
    const body = buildPayload(null, [turn("new")], digests);
    const entries = body.turns.filter((item) => !item.isNew);
    // The budget counts the serialized entries — keys, quotes, escapes included.
    const total = entries.reduce((sum, item) => sum + JSON.stringify(item).length, 0);
    expect(total).toBeLessThanOrEqual(MAX_DIGEST_INPUT_CHARS);
    // Dropped strictly oldest-first until one more would overflow.
    const dropped = digests.length - entries.length;
    expect(dropped).toBeGreaterThan(0);
    const nextOldest = digests[dropped - 1];
    const nextSize = JSON.stringify({
      id: nextOldest.id,
      isNew: false,
      completedAt: nextOldest.completedAt,
      userInput: nextOldest.userInput,
      step: nextOldest.step,
      digest: nextOldest.digest,
    }).length;
    expect(total + nextSize).toBeGreaterThan(MAX_DIGEST_INPUT_CHARS);
    expect(entries.at(-1)?.id).toBe("t29");
    expect(body.turns.at(-1)?.id).toBe("new");
  });

  it("never sends digests for turns inside the recent window, even at the cap", () => {
    const big = "摘".repeat(2_000);
    // t1/t2 sit inside the window: their digests merge into the window entries
    // instead of digest entries, and must not eat the cap either.
    const digests = Array.from({ length: 30 }, (_, index) => digest(`t${index}`, big));
    const body = buildPayload("t2", [turn("t1"), turn("t2"), turn("t3")], [
      ...digests,
      digest("t1"),
      digest("t2"),
    ]);
    const ids = body.turns.map((item) => item.id);
    // t1/t2 appear once each — merged into their window entries, never
    // duplicated as digest entries.
    expect(ids.filter((id) => id === "t1")).toHaveLength(1);
    expect(ids.filter((id) => id === "t2")).toHaveLength(1);
  });
});

describe("newTurnIds", () => {
  const turnsOf = (n: number) =>
    Array.from({ length: n }, (_, i) => turn(`t${i}`));

  it("marks every stored turn new on the first analysis (historyTurnId=null)", () => {
    expect([...newTurnIds(turnsOf(3), null)]).toEqual(["t0", "t1", "t2"]);
  });

  it("marks only turns after the boundary as new", () => {
    expect([...newTurnIds(turnsOf(5), "t2")]).toEqual(["t3", "t4"]);
  });

  it("marks nothing when the last turn is the boundary", () => {
    expect([...newTurnIds(turnsOf(4), "t3")]).toEqual([]);
  });

  it("marks the whole window new when the boundary fell out of it", () => {
    const turns = turnsOf(8);
    expect([...newTurnIds(turns, "t1")]).toEqual(["t3", "t4", "t5", "t6", "t7"]);
  });
});
