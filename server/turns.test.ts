import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "./host-types";
import {
  declaredFrom,
  firstUserMessageFrom,
  joinText,
  stableTextHash,
  turnFromTurnEnded,
  turnsFromTimelineEntries,
  type BackfillEntry,
} from "./turns";

const user = (text: string) => ({ type: "user_message", text }) as AgentTimelineItem;
const assistant = (text: string) => ({ type: "assistant_message", text }) as AgentTimelineItem;
const error = (message: string) => ({ type: "error", message }) as AgentTimelineItem;
const completed = { kind: "completed" } as const;

describe("joinText", () => {
  it("concatenates chunks as-is and spaces separate sentences", () => {
    expect(joinText("", "Hel")).toBe("Hel");
    expect(joinText("Hel", "lo")).toBe("Hello");
    expect(joinText("Done.", "Next")).toBe("Done. Next");
  });
});

describe("turnFromTurnEnded", () => {
  it("uses the last non-empty user message and joins assistant chunks after it", () => {
    const turn = turnFromTurnEnded(
      [user("old"), assistant("old reply"), user("  "), user("做点事"), assistant("已"), assistant("完成")],
      completed,
      "t1",
      500,
    );
    expect(turn).toMatchObject({
      id: "t1",
      userInput: "做点事",
      agentOutput: "已完成",
      outcome: "completed",
      completedAt: 500,
      contextIncomplete: false,
    });
    expect(turn?.dedupeKey).toBe(stableTextHash("做点事\0已完成"));
  });

  it("appends error items to the output", () => {
    const turn = turnFromTurnEnded([user("x"), assistant("尝试"), error("boom")], completed, "t", 1);
    expect(turn?.agentOutput).toBe("尝试\n错误：boom");
  });

  it("writes a failure note when a failed turn has no output", () => {
    const turn = turnFromTurnEnded(
      [user("x")],
      { kind: "failed", error: { message: "quota" } },
      "t",
      1,
    );
    expect(turn?.agentOutput).toBe("本轮失败：quota");
    expect(turn?.outcome).toBe("failed");
  });

  it("returns null for canceled turns and empty output", () => {
    expect(turnFromTurnEnded([user("x"), assistant("y")], { kind: "canceled" }, "t", 1)).toBeNull();
    expect(turnFromTurnEnded([user("x")], completed, "t", 1)).toBeNull();
  });

  it("marks context incomplete without a user message and derives an id", () => {
    const turn = turnFromTurnEnded([assistant("hi")], completed, null, 1);
    expect(turn?.contextIncomplete).toBe(true);
    expect(turn?.userInput).toBeNull();
    expect(turn?.id).toBe(`h:${turn?.dedupeKey}`);
  });

  it("keeps only the tail of very long output", () => {
    const turn = turnFromTurnEnded([user("x"), assistant(`a${"b".repeat(20_000)}`)], completed, "t", 1);
    expect(turn?.agentOutput.length).toBe(16_000);
    expect(turn?.agentOutput.startsWith("a")).toBe(false);
  });
});

describe("firstUserMessageFrom", () => {
  it("returns the first non-empty user message", () => {
    expect(firstUserMessageFrom([assistant("a"), user(" "), user(" 第一条 "), user("第二条")])).toBe("第一条");
    expect(firstUserMessageFrom([assistant("a")])).toBeNull();
  });
});

describe("turnsFromTimelineEntries", () => {
  const entry = (item: AgentTimelineItem, seq: number, turnId?: string): BackfillEntry => ({
    item,
    turnId,
    seqStart: seq,
    timestamp: new Date(1_000 * seq).toISOString(),
  });

  it("groups by user message, uses turnId or seq ids, and drops turns without output", () => {
    const turns = turnsFromTimelineEntries([
      entry(user("a"), 1, "T1"),
      entry(assistant("A1"), 2, "T1"),
      entry(assistant("A2"), 3, "T1"),
      entry(user("b"), 4),
      entry(assistant("B"), 5),
      entry(user("c"), 6, "T3"),
    ]);
    expect(turns.map((turn) => turn.id)).toEqual(["T1", "seq:4"]);
    expect(turns[0]).toMatchObject({ userInput: "a", agentOutput: "A1A2", completedAt: 3_000 });
  });

  it("keeps the last five turns", () => {
    const entries: BackfillEntry[] = [];
    for (let index = 0; index < 8; index += 1) {
      entries.push(entry(user(`u${index}`), index * 2));
      entries.push(entry(assistant(`a${index}`), index * 2 + 1));
    }
    const turns = turnsFromTimelineEntries(entries);
    expect(turns).toHaveLength(5);
    expect(turns[0].userInput).toBe("u3");
  });
});

describe("declared results", () => {
  const tool = { type: "tool_call", name: "Bash" } as unknown as AgentTimelineItem;
  const reply = (text: string, messageId?: string) =>
    ({ type: "assistant_message", text, messageId }) as AgentTimelineItem;

  it("parses the first non-empty line, tolerating bold and half-width colons", () => {
    expect(declaredFrom("\n完成：方案已写好\n/abs/design-a.md")).toEqual({ kind: "done", text: "方案已写好" });
    expect(declaredFrom("**阻塞：** 缺少权限")).toEqual({ kind: "blocked", text: "缺少权限" });
    expect(declaredFrom("**失败**: 测试跑不起来")).toEqual({ kind: "failed", text: "测试跑不起来" });
    expect(declaredFrom("已完成：方案")).toBeNull();
    expect(declaredFrom("这里说明一下\n完成：x")).toBeNull();
  });

  it("reads only the final reply of a turn", () => {
    const turn = turnFromTurnEnded(
      [user("做方案"), assistant("完成：先说一句"), tool, assistant("我继续"), assistant("看看")],
      completed,
      "t",
      1,
    );
    expect(turn?.declared).toBeNull();
    const done = turnFromTurnEnded(
      [user("做方案"), assistant("先看代码"), tool, assistant("完成："), assistant("已写好\n/x.md")],
      completed,
      "t",
      1,
    );
    expect(done?.declared).toEqual({ kind: "done", text: "已写好" });
  });

  it("splits adjacent replies with different message ids", () => {
    const turn = turnFromTurnEnded(
      [user("x"), reply("完成：旧的", "m1"), reply("补充说明", "m2")],
      completed,
      "t",
      1,
    );
    expect(turn?.declared).toBeNull();
  });

  it("ignores declarations on failed turns", () => {
    const turn = turnFromTurnEnded(
      [user("x"), assistant("完成：好了")],
      { kind: "failed", error: { message: "boom" } },
      "t",
      1,
    );
    expect(turn?.declared).toBeNull();
  });

  it("parses declarations in backfilled turns", () => {
    const entries: BackfillEntry[] = [
      { item: user("做"), timestamp: "2026-01-01T00:00:00Z", seqStart: 1 },
      { item: assistant("看看"), timestamp: "2026-01-01T00:00:01Z", seqStart: 2 },
      { item: tool, timestamp: "2026-01-01T00:00:02Z", seqStart: 3 },
      { item: assistant("阻塞：需要确认接口"), timestamp: "2026-01-01T00:00:03Z", seqStart: 4 },
    ];
    expect(turnsFromTimelineEntries(entries)[0].declared).toEqual({
      kind: "blocked",
      text: "需要确认接口",
    });
  });
});
