import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "./host-types";
import {
  declaredFrom,
  firstUserMessageFrom,
  joinText,
  stableTextHash,
  timelineCursorOf,
  turnFromTurnEnded,
  turnStartFromCursor,
  turnsFromTimelineEntries,
  type BackfillEntry,
} from "./turns";

const user = (text: string) => ({ type: "user_message", text }) as AgentTimelineItem;
const assistant = (text: string) => ({ type: "assistant_message", text }) as AgentTimelineItem;
const error = (message: string) => ({ type: "error", message }) as AgentTimelineItem;
const toolCall = (detailType: string) =>
  ({ type: "tool_call", detail: { type: detailType } }) as unknown as AgentTimelineItem;
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
    )?.turn;
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
    const turn = turnFromTurnEnded([user("x"), assistant("尝试"), error("boom")], completed, "t", 1)?.turn;
    expect(turn?.agentOutput).toBe("尝试\n错误：boom");
  });

  it("writes a failure note when a failed turn has no output", () => {
    const turn = turnFromTurnEnded(
      [user("x")],
      { kind: "failed", error: { message: "quota" } },
      "t",
      1,
    )?.turn;
    expect(turn?.agentOutput).toBe("本轮失败：quota");
    expect(turn?.outcome).toBe("failed");
  });

  it("returns null for canceled turns and empty output", () => {
    expect(turnFromTurnEnded([user("x"), assistant("y")], { kind: "canceled" }, "t", 1)).toBeNull();
    expect(turnFromTurnEnded([user("x")], completed, "t", 1)).toBeNull();
  });

  it("marks context incomplete without a user message and derives an id", () => {
    const turn = turnFromTurnEnded([assistant("hi")], completed, null, 1)?.turn;
    expect(turn?.contextIncomplete).toBe(true);
    expect(turn?.userInput).toBeNull();
    expect(turn?.id).toBe(`h:${turn?.dedupeKey}`);
  });

  it("keeps only the tail of very long output", () => {
    const turn = turnFromTurnEnded([user("x"), assistant(`a${"b".repeat(20_000)}`)], completed, "t", 1)?.turn;
    expect(turn?.agentOutput.length).toBe(16_000);
    expect(turn?.agentOutput.startsWith("a")).toBe(false);
  });

  it("counts edit and write tool calls only", () => {
    const turn = turnFromTurnEnded(
      [
        user("改代码"),
        toolCall("read"),
        toolCall("edit"),
        toolCall("write"),
        toolCall("shell"),
        assistant("完成：改好了"),
      ],
      completed,
      "t",
      1,
    )?.turn;
    expect(turn?.editCount).toBe(2);
    expect(turn?.declared?.kind).toBe("done");
    // Tool calls before the last user message belong to the previous turn.
    const earlier = turnFromTurnEnded(
      [toolCall("edit"), user("问"), assistant("答")],
      completed,
      "t",
      1,
    )?.turn;
    expect(earlier?.editCount).toBe(0);
  });

  it("slices notification-driven turns at the remembered boundary", () => {
    // The turn_ended timeline is the whole session; each notification turn
    // appends items without a user_message.
    const timeline = [user("做点事"), assistant("第一轮输出")];
    const first = turnFromTurnEnded(timeline, completed, "T1", 1, turnStartFromCursor(null, timeline))?.turn;
    expect(first?.userInput).toBe("做点事");
    expect(first?.agentOutput).toBe("第一轮输出");

    const cursor1 = timelineCursorOf(timeline);
    timeline.push(toolCall("read"), assistant("通知轮一"));
    const second = turnFromTurnEnded(
      timeline,
      completed,
      "T2",
      2,
      turnStartFromCursor(cursor1, timeline),
    );
    expect(second?.turn.userInput).toBeNull();
    expect(second?.turn.agentOutput).toBe("通知轮一");
    expect(second?.turn.contextIncomplete).toBe(false);
    expect(second?.subAgents).toEqual([]);

    const cursor2 = timelineCursorOf(timeline);
    timeline.push(assistant("通知轮二"));
    const third = turnFromTurnEnded(
      timeline,
      completed,
      "T3",
      3,
      turnStartFromCursor(cursor2, timeline),
    );
    expect(third?.turn.userInput).toBeNull();
    expect(third?.turn.agentOutput).toBe("通知轮二");
    expect(third?.turn.contextIncomplete).toBe(false);

    // Without a verified boundary the scan still falls back to the last user message.
    const unbounded = turnFromTurnEnded(timeline, completed, "T3", 3);
    expect(unbounded?.turn.userInput).toBe("做点事");
    expect(unbounded?.turn.agentOutput).toBe("第一轮输出通知轮一通知轮二");
    expect(unbounded?.turn.contextIncomplete).toBe(false);
  });

  it("keeps user-message turns unchanged under a boundary", () => {
    const timeline = [user("第一问"), assistant("答一"), user("第二问"), assistant("答二")];
    const ended = turnFromTurnEnded(
      timeline,
      completed,
      "T2",
      2,
      turnStartFromCursor({ length: 2, tailHash: stableTextHash(JSON.stringify(timeline[1])) }, timeline),
    )?.turn;
    expect(ended?.userInput).toBe("第二问");
    expect(ended?.agentOutput).toBe("答二");
    expect(ended?.contextIncomplete).toBe(false);
  });

  it("accepts a boundary that lands past the last user message", () => {
    const timeline = [user("问"), assistant("答"), assistant("新通知轮")];
    const ended = turnFromTurnEnded(timeline, completed, "T2", 2, 2)?.turn;
    expect(ended?.userInput).toBeNull();
    expect(ended?.agentOutput).toBe("新通知轮");
    expect(ended?.contextIncomplete).toBe(false);
  });

  it("parses the review verdict from the final reply's first line", () => {
    const turn = turnFromTurnEnded(
      [
        user("复核结果"),
        assistant("先说点别的"),
        toolCall("read"),
        assistant("审查复核：成立 2 条，不成立 1 条，存疑 0 条\n逐条结论……"),
      ],
      completed,
      "t",
      1,
    )?.turn;
    expect(turn?.reviewVerdict).toEqual({ valid: 2, invalid: 1, unsure: 0 });
    const plain = turnFromTurnEnded([user("x"), assistant("普通回复")], completed, "t", 1)?.turn;
    expect(plain?.reviewVerdict).toBeNull();
    // Failed turns never carry a verdict.
    const failed = turnFromTurnEnded(
      [user("x"), assistant("审查复核：成立 1 条")],
      { kind: "failed", error: { message: "x" } },
      "t",
      1,
    )?.turn;
    expect(failed?.reviewVerdict).toBeNull();
  });
});

describe("timelineCursor", () => {
  const timeline = () => [user("问"), assistant("答")];

  it("round-trips: the next turn starts right after the stored tail", () => {
    const cursor = timelineCursorOf(timeline());
    expect(turnStartFromCursor(cursor, [...timeline(), assistant("新轮")])).toBe(2);
    expect(turnStartFromCursor(cursor, timeline())).toBe(2);
  });

  it("rejects a mutated or shrunken tail", () => {
    const cursor = timelineCursorOf(timeline());
    expect(turnStartFromCursor(cursor, [user("问"), assistant("变了")])).toBeNull();
    expect(turnStartFromCursor(cursor, [user("问")])).toBeNull();
    expect(turnStartFromCursor(null, timeline())).toBeNull();
    expect(turnStartFromCursor({ length: -1, tailHash: "" }, timeline())).toBeNull();
  });

  it("treats an empty timeline's cursor as the start", () => {
    const cursor = timelineCursorOf([]);
    expect(turnStartFromCursor(cursor, timeline())).toBe(0);
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
    expect(turns.map((built) => built.turn.id)).toEqual(["T1", "seq:4"]);
    expect(turns[0].turn).toMatchObject({ userInput: "a", agentOutput: "A1A2", completedAt: 3_000 });
  });

  it("splits notification turns that share one user message by turnId", () => {
    const turns = turnsFromTimelineEntries([
      entry(user("初始指令"), 1, "T1"),
      entry(assistant("第一轮"), 2, "T1"),
      entry(assistant("通知轮一"), 3, "T2"),
      entry(toolCall("edit"), 4, "T2"),
      entry(assistant("通知轮二"), 5, "T3"),
    ]);
    expect(turns.map((built) => built.turn.id)).toEqual(["T1", "T2", "T3"]);
    expect(turns[0].turn).toMatchObject({ userInput: "初始指令", agentOutput: "第一轮" });
    expect(turns[1].turn).toMatchObject({
      userInput: null,
      agentOutput: "通知轮一",
      editCount: 1,
      contextIncomplete: false,
    });
    expect(turns[2].turn).toMatchObject({ userInput: null, agentOutput: "通知轮二" });
  });

  it("marks only a headless first turn as incomplete and honors hasOlder", () => {
    const entries = [
      entry(assistant("半截输出"), 1, "T9"),
      entry(user("问"), 2, "T10"),
      entry(assistant("答"), 3, "T10"),
    ];
    const [headless] = turnsFromTimelineEntries(entries);
    expect(headless.turn.userInput).toBeNull();
    expect(headless.turn.contextIncomplete).toBe(true);
    const [fromStart] = turnsFromTimelineEntries(entries, false);
    expect(fromStart.turn.contextIncomplete).toBe(false);
  });

  it("adopts the turn id for an untagged user message followed by tagged items", () => {
    const turns = turnsFromTimelineEntries([
      entry(user("没打标的输入"), 1),
      entry(assistant("答"), 2, "T5"),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].turn).toMatchObject({ id: "T5", userInput: "没打标的输入", agentOutput: "答" });
  });

  it("lets a same-turn user message replace the input and reset the output", () => {
    const turns = turnsFromTimelineEntries([
      entry(user("原输入"), 1, "T1"),
      entry(assistant("前半"), 2, "T1"),
      entry(user("steer 补充"), 3, "T1"),
      entry(assistant("后半"), 4, "T1"),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].turn).toMatchObject({ userInput: "steer 补充", agentOutput: "后半" });
  });

  it("keeps the last five turns", () => {
    const entries: BackfillEntry[] = [];
    for (let index = 0; index < 8; index += 1) {
      entries.push(entry(user(`u${index}`), index * 2));
      entries.push(entry(assistant(`a${index}`), index * 2 + 1));
    }
    const turns = turnsFromTimelineEntries(entries);
    expect(turns).toHaveLength(5);
    expect(turns[0].turn.userInput).toBe("u3");
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
    )?.turn;
    expect(turn?.declared).toBeNull();
    const done = turnFromTurnEnded(
      [user("做方案"), assistant("先看代码"), tool, assistant("完成："), assistant("已写好\n/x.md")],
      completed,
      "t",
      1,
    )?.turn;
    expect(done?.declared).toEqual({ kind: "done", text: "已写好" });
  });

  it("splits adjacent replies with different message ids", () => {
    const turn = turnFromTurnEnded(
      [user("x"), reply("完成：旧的", "m1"), reply("补充说明", "m2")],
      completed,
      "t",
      1,
    )?.turn;
    expect(turn?.declared).toBeNull();
  });

  it("ignores declarations on failed turns", () => {
    const turn = turnFromTurnEnded(
      [user("x"), assistant("完成：好了")],
      { kind: "failed", error: { message: "boom" } },
      "t",
      1,
    )?.turn;
    expect(turn?.declared).toBeNull();
  });

  it("parses declarations in backfilled turns", () => {
    const entries: BackfillEntry[] = [
      { item: user("做"), timestamp: "2026-01-01T00:00:00Z", seqStart: 1 },
      { item: assistant("看看"), timestamp: "2026-01-01T00:00:01Z", seqStart: 2 },
      { item: tool, timestamp: "2026-01-01T00:00:02Z", seqStart: 3 },
      { item: assistant("阻塞：需要确认接口"), timestamp: "2026-01-01T00:00:03Z", seqStart: 4 },
    ];
    expect(turnsFromTimelineEntries(entries)[0].turn.declared).toEqual({
      kind: "blocked",
      text: "需要确认接口",
    });
  });

  it("backfill counts edits and parses the review verdict too", () => {
    const entries: BackfillEntry[] = [
      { item: user("审查这个"), timestamp: "2026-01-01T00:00:00Z", seqStart: 1, turnId: "t9" },
      { item: toolCall("edit"), timestamp: "2026-01-01T00:00:01Z", seqStart: 2, turnId: "t9" },
      { item: toolCall("read"), timestamp: "2026-01-01T00:00:02Z", seqStart: 3, turnId: "t9" },
      {
        item: assistant("审查复核：成立 0 条，不成立 2 条，存疑 1 条"),
        timestamp: "2026-01-01T00:00:03Z",
        seqStart: 4,
        turnId: "t9",
      },
    ];
    const [backfilled] = turnsFromTimelineEntries(entries);
    expect(backfilled.turn.editCount).toBe(1);
    expect(backfilled.turn.reviewVerdict).toEqual({ valid: 0, invalid: 2, unsure: 1 });
  });
});

describe("sub_agent extraction", () => {
  const subAgent = (
    description: string,
    options: { subAgentType?: string; status?: string; name?: string } = {},
  ) =>
    ({
      type: "tool_call",
      callId: `call-${description}`,
      name: options.name ?? "Task",
      status: options.status ?? "completed",
      detail: {
        type: "sub_agent",
        subAgentType: options.subAgentType,
        description,
      },
    }) as unknown as AgentTimelineItem;

  it("collects sub_agent tool calls after the last user message", () => {
    const ended = turnFromTurnEnded(
      [
        user("研究一下"),
        subAgent("梳理登录相关代码", { subAgentType: "Explore" }),
        toolCall("edit"),
        subAgent("跑一遍登录测试", { subAgentType: "Verify", status: "failed" }),
        assistant("看完了"),
      ],
      completed,
      "t",
      1,
    );
    expect(ended?.subAgents).toEqual([
      {
        callId: "call-梳理登录相关代码",
        type: "Explore",
        description: "梳理登录相关代码",
        status: "completed",
      },
      {
        callId: "call-跑一遍登录测试",
        type: "Verify",
        description: "跑一遍登录测试",
        status: "failed",
      },
    ]);
    // 上一轮里的 sub_agent 不算进这一轮。
    const older = turnFromTurnEnded(
      [subAgent("旧的", { subAgentType: "Explore" }), user("问"), assistant("答")],
      completed,
      "t",
      1,
    );
    expect(older?.subAgents).toEqual([]);
  });

  it("falls back to the tool name and flattens long descriptions", () => {
    const ended = turnFromTurnEnded(
      [
        user("x"),
        subAgent(`查日志\n看看有没有报错${"很".repeat(300)}`, { status: "running" }),
        assistant("好的"),
      ],
      completed,
      "t",
      1,
    );
    expect(ended?.subAgents[0].type).toBe("Task");
    expect(ended?.subAgents[0].status).toBe("running");
    expect(ended?.subAgents[0].description).toBe(
      `查日志 看看有没有报错${"很".repeat(189)}`,
    );
    expect(ended?.subAgents[0].description.length).toBe(200);
  });

  it("backfilled turns carry their own sub-agents", () => {
    const entries: BackfillEntry[] = [
      { item: user("a"), timestamp: "2026-01-01T00:00:00Z", seqStart: 1, turnId: "T1" },
      {
        item: subAgent("第一轮的任务", { subAgentType: "Explore" }),
        timestamp: "2026-01-01T00:00:01Z",
        seqStart: 2,
        turnId: "T1",
      },
      { item: assistant("A"), timestamp: "2026-01-01T00:00:02Z", seqStart: 3, turnId: "T1" },
      { item: user("b"), timestamp: "2026-01-01T00:00:03Z", seqStart: 4, turnId: "T2" },
      {
        item: subAgent("第二轮的任务", { subAgentType: "Task" }),
        timestamp: "2026-01-01T00:00:04Z",
        seqStart: 5,
        turnId: "T2",
      },
      { item: assistant("B"), timestamp: "2026-01-01T00:00:05Z", seqStart: 6, turnId: "T2" },
    ];
    const built = turnsFromTimelineEntries(entries);
    expect(built[0].subAgents.map((s) => s.description)).toEqual(["第一轮的任务"]);
    expect(built[1].subAgents.map((s) => s.description)).toEqual(["第二轮的任务"]);
  });
});
