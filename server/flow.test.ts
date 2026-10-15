import { describe, expect, it } from "vitest";
import type { FlowChild, TurnSubAgent } from "../shared/types";
import { buildFlow, MAX_DRAWN_TURNS, type FlowTurnInput } from "./flow";
import { MAX_MERMAID_CHARS, renderMermaid } from "./mermaid";

const BASE = 1_760_000_000_000;

const turn = (id: string, at: number, overrides: Partial<FlowTurnInput> = {}): FlowTurnInput => ({
  turnId: id,
  completedAt: BASE + at * 60_000,
  userInput: `输入-${id}`,
  step: `步骤-${id}`,
  historyLabel: null,
  digest: `摘要-${id}`,
  outcome: "completed",
  declared: null,
  subAgents: [],
  ...overrides,
});

const subAgent = (callId: string, overrides: Partial<TurnSubAgent> = {}): TurnSubAgent => ({
  callId,
  type: "Explore",
  description: `任务-${callId}`,
  status: "completed",
  ...overrides,
});

const child = (
  id: string,
  at: number,
  overrides: Partial<FlowChild> = {},
): FlowChild => ({
  id,
  createdAt: BASE + at * 60_000,
  columnLabel: "已完成",
  detail: "完成：做完了",
  ...overrides,
});

const flow = (
  turns: FlowTurnInput[],
  children: FlowChild[] = [],
  running: string | null = null,
) => buildFlow({ turns, children, running });

describe("buildFlow", () => {
  it("chains turns oldest-first with step, clock, and user input labels", () => {
    const result = flow([
      turn("t2", 2),
      turn("t1", 1),
      turn("t3", 3),
    ]);
    expect(result.code).toContain("flowchart TD");
    expect(result.code.indexOf('t1["①')).toBeLessThan(result.code.indexOf('t2["②'));
    expect(result.code.indexOf('t2["②')).toBeLessThan(result.code.indexOf('t3["③'));
    expect(result.code).toContain("步骤-t1");
    expect(result.code).toContain("你：输入-t1");
    expect(result.code).toContain("t1 --> t2 --> t3");
    expect(result.turns.map((item) => item.index)).toEqual([1, 2, 3]);
    expect(result.turns.map((item) => item.turnId)).toEqual(["t1", "t2", "t3"]);
  });

  it("labels un-analyzed turns from the 之前 entry, then the user input", () => {
    const result = flow([
      turn("t1", 1, { step: null, historyLabel: "调研完成" }),
      turn("t2", 2, { step: null }),
      turn("t3", 3, { step: null, userInput: null }),
    ]);
    expect(result.code).toContain("调研完成");
    expect(result.code).toContain("你：输入-t2");
    // No step, no input: the label falls back to the bare circled index + clock.
    expect(result.code).toMatch(/t3\["③ \d{2}:\d{2}"\]/);
  });

  it("draws each sub_agent tool call off its turn with status marks", () => {
    const result = flow([
      turn("t1", 1, {
        subAgents: [
          subAgent("c1"),
          subAgent("c2", { type: "Task", status: "failed" }),
          subAgent("c3", { status: "canceled" }),
        ],
      }),
    ]);
    expect(result.code).toContain('a1["子 Agent · Explore<br/>任务-c1"]');
    expect(result.code).toContain("子 Agent · Task（失败）");
    expect(result.code).toContain("（已取消）");
    expect(result.code).toContain("t1 -.-> a1");
    expect(result.code).toContain("t1 -.-> a3");
    expect(result.turns[0].subAgents).toHaveLength(3);
  });

  it("merges sub-agents past 6 into one overflow node", () => {
    const result = flow([
      turn("t1", 1, { subAgents: Array.from({ length: 8 }, (_, i) => subAgent(`c${i}`)) }),
    ]);
    expect(result.code).toContain("另有 2 个子 Agent");
    expect(result.code.match(/t1 -\.-> a\d/g)).toHaveLength(7);
  });

  it("attributes child sessions to the turn they were created in", () => {
    const result = flow(
      [turn("t1", 1), turn("t2", 3)],
      [child("k1", 2), child("k2", 4)],
    );
    expect(result.code).toContain('c1["子会话 · 已完成<br/>完成：做完了"]');
    expect(result.code).toContain("t2 -.-> c1");
    // k2 is newer than the last turn and nothing is running: hangs on t2.
    expect(result.code).toContain("t2 -.-> c2");
    expect(result.turns[1].children.map((item) => item.id)).toEqual(["k1", "k2"]);
  });

  it("hangs late children on the running node while the session works", () => {
    const result = flow([turn("t1", 1)], [child("k1", 5)], "等你确认");
    expect(result.code).toContain('w["进行中：等你确认"]');
    expect(result.code).toContain("t1 -.-> w");
    expect(result.code).toContain("w -.-> c1");
    expect(result.code).toContain("class w live");
    // List matches the chart: the child belongs to 进行中, not the last turn.
    expect(result.turns[0].children).toEqual([]);
  });

  it("marks failed turns red and blocked declarations orange", () => {
    const result = flow([
      turn("t1", 1, { outcome: "failed" }),
      turn("t2", 2, { declared: { kind: "blocked", text: "卡在权限" } }),
      turn("t3", 3, { declared: { kind: "failed", text: "自报失败" } }),
    ]);
    expect(result.code).toContain("class t1 fail");
    expect(result.code).toContain("class t2 blocked");
    expect(result.code).toContain("class t3 fail");
    expect(result.code).toContain("classDef fail stroke:#dc2626");
    expect(result.code).toContain("classDef blocked stroke:#ea580c");
  });

  it("folds all but the newest 30 turns into one earlier node", () => {
    const turns = Array.from({ length: MAX_DRAWN_TURNS + 5 }, (_, i) => turn(`t${i + 1}`, i + 1));
    const result = flow(turns, [child("old", 1)]);
    expect(result.code).toContain(`e["更早 5 轮"]`);
    expect(result.code).not.toContain('t1["①');
    expect(result.code).toContain(`t${MAX_DRAWN_TURNS + 5}["`);
    expect(result.code).toContain(`e --> t6 --> `);
    // A child created during a folded turn still appears, off the 更早 node.
    expect(result.code).toContain("e -.-> c1");
    expect(result.turns).toHaveLength(MAX_DRAWN_TURNS + 5);
    expect(result.turns[0].children.map((item) => item.id)).toEqual(["old"]);
  });

  it("escapes mermaid-hostile characters in labels", () => {
    const result = flow([
      turn("t1", 1, {
        step: '改 "a" <b> & c\n第二行',
        userInput: '输入带 #号 和 "引号"',
        subAgents: [subAgent("c1", { description: '找 "<x>"' })],
      }),
    ]);
    expect(result.code).not.toContain('"a"');
    expect(result.code).not.toContain("<b>");
    expect(result.code).toContain("#quot;");
    expect(result.code).toContain("#lt;");
    expect(result.code).toContain("#gt;");
    expect(result.code).toContain("#amp;");
    expect(result.code).toContain("#35;");
    // A newline in a label becomes a space, never a raw line break.
    expect(result.code).not.toContain('第二行\n');
  });

  it("escapes % and braces so labels cannot become mermaid directives", () => {
    const result = flow([
      turn("t1", 1, {
        step: "注入 %{init} 和 {x}",
        userInput: "%%{init: ",
      }),
    ]);
    expect(result.code).not.toContain("%%");
    expect(result.code).not.toContain("{init:");
    expect(result.code).toContain("#37;");
    expect(result.code).toContain("#123;");
    expect(result.code).toContain("#125;");
  });

  it("clips on escaped length so entities cannot overflow a label", () => {
    const result = flow([
      turn("t1", 1, { step: '"'.repeat(50), userInput: null }),
    ]);
    // 50 quotes → 300 escaped chars; clipped well under the 40-char budget.
    expect(result.code).not.toContain("#quot;".repeat(8));
    expect(result.code).toContain("…");
  });

  it("clips the sub-agent type like every other label part", () => {
    const result = flow([
      turn("t1", 1, { subAgents: [subAgent("c1", { type: "X".repeat(60) })] }),
    ]);
    expect(result.code).not.toContain("X".repeat(60));
    expect(result.code).toContain("子 Agent · ");
  });

  it("caps folded-turn children at 6 nodes off the 更早 node", () => {
    const turns = Array.from({ length: MAX_DRAWN_TURNS + 5 }, (_, i) =>
      turn(`t${i + 1}`, i + 1),
    );
    const children = Array.from({ length: 10 }, (_, i) => child(`k${i}`, 1 + i * 0.01));
    const result = flow(turns, children);
    expect(result.code).toContain('e["更早 5 轮"]');
    expect(result.code.match(/e -\.-> c\d/g)).toHaveLength(6);
    expect(result.code).toContain("另有 4 个子会话");
    // The list keeps all of them on their folded turns.
    const foldedRows = result.turns.slice(0, 5);
    expect(foldedRows.flatMap((row) => row.children)).toHaveLength(10);
  });

  it("caps late children at 6 nodes off the running node", () => {
    const children = Array.from({ length: 9 }, (_, i) => child(`k${i}`, 10 + i));
    const result = flow([turn("t1", 1)], children, "等你确认");
    expect(result.code.match(/w -\.-> c\d/g)).toHaveLength(6);
    expect(result.code).toContain("另有 3 个子会话");
  });

  it("carries the 之前 fallback label into the list rows", () => {
    const result = flow([turn("t1", 1, { step: null, historyLabel: "调研完成" })]);
    expect(result.turns[0].historyLabel).toBe("调研完成");
  });

  it("keeps the source under the renderer's limit even at the fold", () => {
    const turns = Array.from({ length: 80 }, (_, i) =>
      turn(`t${i + 1}`, i + 1, {
        step: `一段比较长一点的步骤名-${i}-${"字".repeat(24)}`,
        userInput: `用户输入-${i}-${"问".repeat(18)}`,
        subAgents: Array.from({ length: 8 }, (_, j) => subAgent(`c${i}-${j}`)),
      }),
    );
    const result = flow(turns, [child("k", 5)], "收尾中");
    expect(result.code.length).toBeLessThanOrEqual(MAX_MERMAID_CHARS);
  });

  it("stays under the limit with hundreds of children and sub-agents", () => {
    const turns = Array.from({ length: 60 }, (_, i) =>
      turn(`t${i + 1}`, i + 1, {
        subAgents: Array.from({ length: 10 }, (_, j) => subAgent(`c${i}-${j}`)),
      }),
    );
    // 150 children all newer than the last turn: one place, merged overflow.
    const children = Array.from({ length: 150 }, (_, i) => child(`k${i}`, 70 + i));
    const result = flow(turns, children, "等你确认");
    expect(result.code.length).toBeLessThanOrEqual(MAX_MERMAID_CHARS);
    // Whichever rung it landed on, the late pile collapsed into one overflow.
    expect(result.code).toMatch(/另有 \d+ 个子会话/);
  });
});

describe("buildFlow → renderMermaid", () => {
  it("renders the generated source to a PNG", async () => {
    const { code } = flow(
      [
        turn("t1", 1, { subAgents: [subAgent("c1", { status: "failed" })] }),
        turn("t2", 3, { declared: { kind: "blocked", text: "卡在确认" } }),
      ],
      [child("k1", 2), child("k2", 4, { columnLabel: "进行中", detail: null })],
      "等你确认",
    );
    const result = await renderMermaid(code, "light");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
    }
  }, 30_000);

  it("renders source whose labels carry mermaid directive syntax", async () => {
    const { code } = flow(
      [
        turn("t1", 1, {
          step: '注入 %%{init: {"theme":"dark"}}%% 和 {x} 试渲染',
          userInput: '用户输入带 %%{init: 和 <b> & "引号"',
          subAgents: [subAgent("c1", { description: "找 %{config}%" })],
        }),
      ],
      [child("k1", 2, { detail: "完成：{ok}%" })],
    );
    const result = await renderMermaid(code, "light");
    expect(result.ok).toBe(true);
  }, 30_000);
});
