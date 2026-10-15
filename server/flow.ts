/**
 * Builds the per-session mermaid flowchart and the per-turn digest list from
 * history.db rows plus turns still only in memory. Pure — the graph source is
 * assembled here, never by the model.
 */
import type { Declared, FlowChild, FlowTurn, TurnSubAgent } from "../shared/types";
import { MAX_MERMAID_CHARS } from "./mermaid";

/** One turn of the flow chart, merged from a history.db row or a live record. */
export type FlowTurnInput = {
  turnId: string;
  completedAt: number;
  /** User input head; null when the turn had none. */
  userInput: string | null;
  /** Analyzer step name; null until the turn has been analyzed. */
  step: string | null;
  /** First 之前 entry of this turn — the label fallback for un-analyzed turns. */
  historyLabel: string | null;
  digest: string | null;
  outcome: string;
  declared: Declared | null;
  subAgents: TurnSubAgent[];
};

export type FlowInput = {
  turns: readonly FlowTurnInput[];
  children: readonly FlowChild[];
  /** Text for the trailing dashed node while the session is mid-turn. */
  running: string | null;
};

export type FlowResult = {
  /** Mermaid flowchart source. */
  code: string;
  /** Every turn, oldest first, for the expandable list under the chart. */
  turns: FlowTurn[];
};

/** Beyond this many turns the chart folds the oldest into one 更早 node. */
export const MAX_DRAWN_TURNS = 30;
/** Sub-agent + child-session nodes drawn per place; the rest merge into one. */
const MAX_SUB_NODES_PER_TURN = 6;
const USER_INPUT_NODE_CHARS = 20;
const TURN_LABEL_CHARS = 40;
const SUB_NODE_LINE_CHARS = 30;
const RUNNING_LABEL_CHARS = 60;

/** Escapes label text for mermaid double-quoted node labels. */
function esc(value: string): string {
  return value
    .replace(/#/g, "#35;")
    .replace(/&/g, "#amp;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    // A raw "%" can open a mermaid directive (%%{init:…}%%) inside a label;
    // braces are flowchart syntax. Both go through numeric entities.
    .replace(/%/g, "#37;")
    .replace(/\{/g, "#123;")
    .replace(/\}/g, "#125;")
    .replace(/\s+/g, " ")
    .trim();
}

/** Escapes then clips to `max` chars; a cut never lands mid-entity. */
function clipEscaped(value: string, max: number): string {
  const escaped = esc(value);
  if (escaped.length <= max) {
    return escaped;
  }
  let cut = escaped.slice(0, Math.max(0, max - 1));
  // A trailing "#…" without its ";" is half an entity — back it off whole.
  const hash = cut.lastIndexOf("#");
  if (hash >= 0 && !cut.slice(hash).includes(";")) {
    cut = cut.slice(0, hash);
  }
  return `${cut}…`;
}

/** First non-empty line, unclipped. */
function firstLine(value: string | null): string {
  if (!value) {
    return "";
  }
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") {
      return trimmed;
    }
  }
  return "";
}

/** ①–㊿ keep node ids compact; beyond 50 fall back to `N.`. */
function circled(index: number): string {
  if (index >= 1 && index <= 20) {
    return String.fromCodePoint(0x2460 + index - 1);
  }
  if (index >= 21 && index <= 35) {
    return String.fromCodePoint(0x3251 + index - 21);
  }
  if (index >= 36 && index <= 50) {
    return String.fromCodePoint(0x32b1 + index - 36);
  }
  return `${index}.`;
}

function clockOf(at: number): string {
  const date = new Date(at);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** step → 该轮的「之前」条目 → 用户输入首行. */
function turnTitle(turn: FlowTurnInput, index: number): string {
  const name =
    turn.step?.trim() || turn.historyLabel?.trim() || firstLine(turn.userInput);
  const head = `${circled(index)} ${clockOf(turn.completedAt)}`;
  return name === "" ? head : `${head} ${clipEscaped(name, TURN_LABEL_CHARS)}`;
}

/** Node label: `③ 10:42 修复登录超时` + `你：<输入首行>`. */
function turnLabel(turn: FlowTurnInput, index: number): string {
  const lines = [turnTitle(turn, index)];
  const input = firstLine(turn.userInput);
  if (input !== "") {
    lines.push(`你：${clipEscaped(input, USER_INPUT_NODE_CHARS)}`);
  }
  return lines.join("<br/>");
}

/** `子 Agent · Explore` + description; failed/canceled get a mark. */
function subAgentLabel(subAgent: TurnSubAgent): string {
  const mark =
    subAgent.status === "failed"
      ? "（失败）"
      : subAgent.status === "canceled"
        ? "（已取消）"
        : "";
  const title = `子 Agent · ${clipEscaped(subAgent.type, SUB_NODE_LINE_CHARS)}${mark}`;
  const description = clipEscaped(subAgent.description, SUB_NODE_LINE_CHARS);
  return description === "" ? title : `${title}<br/>${description}`;
}

/** `子会话 · 已完成` + 自声明结果或标题. */
function childLabel(child: FlowChild): string {
  const title = `子会话 · ${clipEscaped(child.columnLabel, SUB_NODE_LINE_CHARS)}`;
  const detail = child.detail === null ? "" : clipEscaped(child.detail, SUB_NODE_LINE_CHARS);
  return detail === "" ? title : `${title}<br/>${detail}`;
}

/**
 * Places each child session on the turn it was created in
 * (上一轮结束 < 创建时间 ≤ 本轮结束); later than the last turn lands in `late`.
 */
function attributeChildren(
  turns: readonly FlowTurnInput[],
  children: readonly FlowChild[],
): { byTurn: Map<number, FlowChild[]>; late: FlowChild[] } {
  const byTurn = new Map<number, FlowChild[]>();
  const late: FlowChild[] = [];
  for (const child of children) {
    const index = turns.findIndex((turn) => child.createdAt <= turn.completedAt);
    if (index < 0) {
      late.push(child);
      continue;
    }
    const list = byTurn.get(index) ?? [];
    list.push(child);
    byTurn.set(index, list);
  }
  return { byTurn, late };
}

/**
 * (drawn turns, aux nodes per place) tried in order until the source fits
 * MAX_MERMAID_CHARS. The last rung draws a single turn and no aux nodes, which
 * is always small enough.
 */
const SIZE_RUNGS: ReadonlyArray<readonly [number, number]> = [
  [MAX_DRAWN_TURNS, MAX_SUB_NODES_PER_TURN],
  [MAX_DRAWN_TURNS, 3],
  [MAX_DRAWN_TURNS, 1],
  [MAX_DRAWN_TURNS, 0],
  [20, 0],
  [10, 0],
  [4, 0],
  [1, 0],
];

/** Assembles the mermaid source for one (turnCap, subCap) rung. */
function renderCode(
  turns: readonly FlowTurnInput[],
  byTurn: ReadonlyMap<number, FlowChild[]>,
  late: readonly FlowChild[],
  running: string | null,
  turnCap: number,
  subCap: number,
): string {
  const folded = Math.max(0, turns.length - turnCap);
  const drawn = turns.slice(folded);
  const lastNodeId = drawn.length > 0 ? `t${turns.length}` : null;

  const lines: string[] = ["flowchart TD"];
  const styled: string[] = [];

  if (folded > 0) {
    lines.push(`    e["更早 ${folded} 轮"]`);
  }
  for (const [offset, turn] of drawn.entries()) {
    const index = folded + offset + 1;
    lines.push(`    t${index}["${turnLabel(turn, index)}"]`);
    if (turn.outcome === "failed" || turn.declared?.kind === "failed") {
      styled.push(`    class t${index} fail`);
    } else if (turn.declared?.kind === "blocked") {
      styled.push(`    class t${index} blocked`);
    }
  }
  if (running !== null) {
    lines.push(`    w["进行中：${clipEscaped(running, RUNNING_LABEL_CHARS)}"]`);
  }

  const chain: string[] = folded > 0 ? ["e"] : [];
  for (const [offset] of drawn.entries()) {
    chain.push(`t${folded + offset + 1}`);
  }
  if (chain.length > 1) {
    lines.push(`    ${chain.join(" --> ")}`);
  }
  if (running !== null && lastNodeId !== null) {
    lines.push(`    ${lastNodeId} -.-> w`);
  }

  let auxSeq = 0;
  const emitAux = (from: string, label: string): void => {
    auxSeq += 1;
    lines.push(`    a${auxSeq}["${label}"]`);
    lines.push(`    ${from} -.-> a${auxSeq}`);
  };
  let childSeq = 0;
  const emitChild = (from: string, child: FlowChild): void => {
    childSeq += 1;
    lines.push(`    c${childSeq}["${childLabel(child)}"]`);
    lines.push(`    ${from} -.-> c${childSeq}`);
  };
  /** Up to subCap child-session nodes in one place; the rest merge into one. */
  const emitChildren = (from: string, list: readonly FlowChild[]): void => {
    let emitted = 0;
    for (const child of list) {
      if (emitted >= subCap) {
        break;
      }
      emitted += 1;
      emitChild(from, child);
    }
    if (list.length > emitted) {
      emitAux(from, `另有 ${list.length - emitted} 个子会话`);
    }
  };
  for (const [offset, turn] of drawn.entries()) {
    const turnIndex = folded + offset;
    const nodeId = `t${turnIndex + 1}`;
    const kids = byTurn.get(turnIndex) ?? [];
    const total = turn.subAgents.length + kids.length;
    let emitted = 0;
    for (const subAgent of turn.subAgents) {
      if (emitted >= subCap) {
        break;
      }
      emitted += 1;
      emitAux(nodeId, subAgentLabel(subAgent));
    }
    for (const child of kids) {
      if (emitted >= subCap) {
        break;
      }
      emitted += 1;
      emitChild(nodeId, child);
    }
    const overflow = total - emitted;
    if (overflow > 0) {
      emitAux(nodeId, `另有 ${overflow} 个子 Agent`);
    }
  }
  // Children of folded turns hang on the 更早 node so none are lost.
  const foldedKids: FlowChild[] = [];
  for (let index = 0; index < folded; index += 1) {
    foldedKids.push(...(byTurn.get(index) ?? []));
  }
  emitChildren("e", foldedKids);
  // Children newer than the last turn hang on 进行中, else on the last turn.
  if (running !== null) {
    emitChildren("w", late);
  } else if (lastNodeId !== null) {
    emitChildren(lastNodeId, late);
  }

  lines.push("    classDef fail stroke:#dc2626,stroke-width:2px");
  lines.push("    classDef blocked stroke:#ea580c,stroke-width:2px");
  lines.push("    classDef live stroke-dasharray:4 3");
  if (running !== null) {
    lines.push("    class w live");
  }
  lines.push(...styled);
  return lines.join("\n");
}

export function buildFlow(input: FlowInput): FlowResult {
  const turns = [...input.turns].sort((a, b) => a.completedAt - b.completedAt);
  const children = [...input.children].sort((a, b) => a.createdAt - b.createdAt);
  const { byTurn, late } = attributeChildren(turns, children);

  // The list below the chart carries every turn; only the drawn graph shrinks.
  const list: FlowTurn[] = turns.map((turn, index) => ({
    turnId: turn.turnId,
    index: index + 1,
    completedAt: turn.completedAt,
    userInput: turn.userInput,
    step: turn.step,
    historyLabel: turn.historyLabel,
    digest: turn.digest,
    outcome: turn.outcome,
    subAgents: turn.subAgents,
    // Late children hang on 进行中 while running — matching the chart means
    // they only join the last turn's row once the session is idle again.
    children: [
      ...(byTurn.get(index) ?? []),
      ...(index === turns.length - 1 && input.running === null ? late : []),
    ],
  }));

  let code = "";
  for (const [turnCap, subCap] of SIZE_RUNGS) {
    code = renderCode(turns, byTurn, late, input.running, turnCap, subCap);
    if (code.length <= MAX_MERMAID_CHARS) {
      break;
    }
  }
  return { code, turns: list };
}
