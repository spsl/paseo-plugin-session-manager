/** Pure helpers turning Paseo timelines into analyzer turns. */
import {
  DECLARED_TEXT_MAX_LENGTH,
  type Declared,
  type DeclaredKind,
  type ReviewVerdict,
  type Turn,
  type TurnSubAgent,
} from "../shared/types";
import type { AgentTimelineItem } from "./host-types";
import { parseReviewVerdict } from "./review";

export const MAX_TEXT_LENGTH = 16_000;
export const BACKFILL_TURNS = 5;

/** Sub-agent tool calls kept per turn (flow chart shows at most 6 nodes). */
export const MAX_TURN_SUB_AGENTS = 20;
const SUB_AGENT_DESCRIPTION_MAX = 200;

export function stableTextHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Streamed replies arrive as chunks that may split anywhere, so chunks are
 * concatenated as-is. Two separate messages (before and after a tool call)
 * arrive without a space: a sentence end followed by a capital gets one.
 */
export function joinText(left: string, right: string): string {
  if (left === "") {
    return right;
  }
  if (/[.!?]$/.test(left) && /^[A-Z]/.test(right)) {
    return `${left} ${right}`;
  }
  return left + right;
}

function tail(value: string): string {
  return value.length > MAX_TEXT_LENGTH ? value.slice(value.length - MAX_TEXT_LENGTH) : value;
}

function head(value: string): string {
  return value.length > MAX_TEXT_LENGTH ? value.slice(0, MAX_TEXT_LENGTH) : value;
}

function appendError(output: string, message: string): string {
  const trimmed = message.trim();
  return trimmed ? `${output.trimEnd()}\n错误：${trimmed}\n` : output;
}

const DECLARED_LINE = /^[*_]*(完成|阻塞|失败)[*_]*\s*[：:]\s*[*_]*\s*(.*)$/;
const DECLARED_KINDS_BY_WORD: Record<string, DeclaredKind> = {
  完成: "done",
  阻塞: "blocked",
  失败: "failed",
};

/** Reads 「完成：…」「阻塞：…」「失败：…」 from the first non-empty line of a reply. */
export function declaredFrom(message: string): Declared | null {
  const line = message.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  const match = DECLARED_LINE.exec(line.trim());
  if (!match) {
    return null;
  }
  const text = match[2].replace(/[*_]+$/, "").trim().slice(0, DECLARED_TEXT_MAX_LENGTH);
  return { kind: DECLARED_KINDS_BY_WORD[match[1]], text };
}

/** Reads the 「审查复核：…」 counts from the first non-empty line of a reply. */
export function reviewVerdictFrom(message: string): ReviewVerdict | null {
  const line = message.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return parseReviewVerdict(line.trim());
}

/** An edit/write tool call in a turn's timeline; drives the review hard trigger. */
function isEditToolCall(item: AgentTimelineItem): boolean {
  return (
    item.type === "tool_call" &&
    (item.detail?.type === "edit" || item.detail?.type === "write")
  );
}

/** A sub_agent tool call in a turn's timeline → a flow-chart sub-agent entry. */
function subAgentOf(item: AgentTimelineItem): TurnSubAgent | null {
  if (item.type !== "tool_call" || item.detail?.type !== "sub_agent") {
    return null;
  }
  const detail = item.detail;
  return {
    callId: item.callId,
    type: detail.subAgentType?.trim() || item.name,
    description: (detail.description ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, SUB_AGENT_DESCRIPTION_MAX),
    status: item.status,
  };
}

/**
 * Tracks the agent's last reply in a turn: consecutive assistant chunks form
 * one reply; any other item (tool call, reasoning) or a new messageId ends it.
 */
class FinalReply {
  private text = "";
  private open = false;
  private messageId: string | undefined;

  add(item: AgentTimelineItem): void {
    if (item.type === "assistant_message") {
      const continues =
        this.open &&
        (item.messageId === undefined ||
          this.messageId === undefined ||
          item.messageId === this.messageId);
      this.text = continues ? joinText(this.text, item.text) : item.text;
      this.open = true;
      this.messageId = item.messageId ?? (continues ? this.messageId : undefined);
    } else if (item.type !== "error") {
      this.open = false;
    }
  }

  declared(): Declared | null {
    return declaredFrom(this.text);
  }

  reviewVerdict(): ReviewVerdict | null {
    return reviewVerdictFrom(this.text);
  }
}

export type TurnOutcomeInput =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string } }
  | { kind: "canceled" };

/**
 * Position in the live timeline where already-ended turns stop. The daemon's
 * projection never merges rows across turns, so items appended after the last
 * turn_ended all belong to the next turn.
 */
export type TimelineCursor = {
  /** Items at indexes < length belong to turns that already ended. */
  length: number;
  /** stableTextHash of the JSON of the item at length - 1; "" when empty. */
  tailHash: string;
};

/** Remembers the tail of a `turn_ended` timeline for the next event's boundary. */
export function timelineCursorOf(timeline: readonly AgentTimelineItem[]): TimelineCursor {
  const last = timeline[timeline.length - 1];
  return {
    length: timeline.length,
    tailHash: last === undefined ? "" : stableTextHash(JSON.stringify(last)),
  };
}

/**
 * The new turn's first index, or null when the cursor can't be verified
 * against this timeline (restart, rewind, or a row mutated after the fact).
 */
export function turnStartFromCursor(
  cursor: TimelineCursor | null,
  timeline: readonly AgentTimelineItem[],
): number | null {
  if (!cursor || cursor.length < 0 || cursor.length > timeline.length) {
    return null;
  }
  const tail = timeline[cursor.length - 1];
  const tailHash = tail === undefined ? "" : stableTextHash(JSON.stringify(tail));
  return tailHash === cursor.tailHash ? cursor.length : null;
}

/** A finished turn plus the sub-agent tool calls spotted inside it. */
export type FinishedTurn = {
  turn: Turn;
  subAgents: TurnSubAgent[];
};

/**
 * Builds the turn that just ended, or null when it should not be recorded.
 * `turnStart` bounds the scan to items produced since the previous turn ended;
 * when unknown, the scan falls back to the last user message in the timeline.
 */
export function turnFromTurnEnded(
  timeline: readonly AgentTimelineItem[],
  outcome: TurnOutcomeInput,
  turnId: string | null,
  now: number,
  turnStart?: number | null,
): FinishedTurn | null {
  if (outcome.kind === "canceled") {
    return null;
  }
  const start =
    turnStart !== null &&
    turnStart !== undefined &&
    Number.isInteger(turnStart) &&
    turnStart >= 0 &&
    turnStart <= timeline.length
      ? turnStart
      : null;
  const scanStart = start ?? 0;
  let userIndex = -1;
  for (let index = timeline.length - 1; index >= scanStart; index -= 1) {
    const item = timeline[index];
    if (item.type === "user_message" && item.text.trim() !== "") {
      userIndex = index;
      break;
    }
  }
  const userInput = userIndex >= 0 ? head((timeline[userIndex] as { text: string }).text.trim()) : null;
  let output = "";
  let editCount = 0;
  const subAgents: TurnSubAgent[] = [];
  const finalReply = new FinalReply();
  for (let index = userIndex >= 0 ? userIndex + 1 : scanStart; index < timeline.length; index += 1) {
    const item = timeline[index];
    finalReply.add(item);
    if (item.type === "assistant_message") {
      output = joinText(output, item.text);
    } else if (item.type === "error") {
      output = appendError(output, item.message);
    }
    if (isEditToolCall(item)) {
      editCount += 1;
    }
    const subAgent = subAgentOf(item);
    if (subAgent && subAgents.length < MAX_TURN_SUB_AGENTS) {
      subAgents.push(subAgent);
    }
  }
  output = output.trim();
  if (output === "" && outcome.kind === "failed") {
    const reason = outcome.error.message.trim();
    output = `本轮失败：${reason || "未知错误"}`;
  }
  if (output === "") {
    return null;
  }
  output = tail(output);
  const dedupeKey = stableTextHash(`${userInput ?? ""}\0${output}`);
  return {
    turn: {
      id: turnId ?? `h:${dedupeKey}`,
      dedupeKey,
      userInput,
      agentOutput: output,
      outcome: outcome.kind,
      completedAt: now,
      contextIncomplete: start === null ? userIndex < 0 : false,
      declared: outcome.kind === "completed" ? finalReply.declared() : null,
      editCount,
      reviewVerdict: outcome.kind === "completed" ? finalReply.reviewVerdict() : null,
    },
    subAgents,
  };
}

/** The first non-empty user message in the timeline, used for title ownership. */
export function firstUserMessageFrom(timeline: readonly AgentTimelineItem[]): string | null {
  for (const item of timeline) {
    if (item.type === "user_message" && item.text.trim() !== "") {
      return head(item.text.trim());
    }
  }
  return null;
}

export type BackfillEntry = {
  item: AgentTimelineItem;
  turnId?: string | null;
  timestamp: string;
  seqStart: number;
};

type Draft = {
  id: string;
  /** Daemon turn attribution; null while every entry so far was untagged. */
  turnId: string | null;
  userInput: string | null;
  output: string;
  completedAt: number;
  finalReply: FinalReply;
  editCount: number;
  subAgents: TurnSubAgent[];
};

function newDraft(id: string, turnId: string | null, userInput: string | null, at: number): Draft {
  return {
    id,
    turnId,
    userInput,
    output: "",
    completedAt: Number.isFinite(at) ? at : 0,
    finalReply: new FinalReply(),
    editCount: 0,
    subAgents: [],
  };
}

/**
 * Groups timeline entries (oldest first) into turns. A change of the daemon's
 * per-entry turnId starts a new turn, so notification-driven turns that never
 * carry a user_message get their own entries with `userInput: null`. An
 * untagged user_message still starts a turn on its own, and untagged head
 * items adopt the turnId of the body that follows them.
 */
export function turnsFromTimelineEntries(
  entries: readonly BackfillEntry[],
  hasOlder?: boolean,
): FinishedTurn[] {
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  for (const entry of entries) {
    const item = entry.item;
    const at = Date.parse(entry.timestamp);
    const entryTurnId = entry.turnId ?? null;
    if (item.type === "user_message") {
      if (item.text.trim() === "") {
        continue;
      }
      if (current && entryTurnId !== null && current.turnId === entryTurnId) {
        // Same-turn message (e.g. a steer): the latest input wins and the
        // output restarts after it, matching the live slicing path.
        current.userInput = head(item.text.trim());
        current.output = "";
        current.finalReply = new FinalReply();
        current.editCount = 0;
        current.subAgents = [];
        continue;
      }
      current = newDraft(entryTurnId ?? `seq:${entry.seqStart}`, entryTurnId, head(item.text.trim()), at);
      drafts.push(current);
      continue;
    }
    if (!current) {
      if (entryTurnId === null) {
        continue;
      }
      current = newDraft(entryTurnId, entryTurnId, null, at);
      drafts.push(current);
    } else if (entryTurnId !== null && current.turnId !== entryTurnId) {
      if (current.turnId === null) {
        current.turnId = entryTurnId;
        current.id = entryTurnId;
      } else {
        current = newDraft(entryTurnId, entryTurnId, null, at);
        drafts.push(current);
      }
    }
    current.finalReply.add(item);
    if (isEditToolCall(item)) {
      current.editCount += 1;
    }
    const subAgent = subAgentOf(item);
    if (subAgent && current.subAgents.length < MAX_TURN_SUB_AGENTS) {
      current.subAgents.push(subAgent);
    }
    if (item.type === "assistant_message") {
      current.output = joinText(current.output, item.text);
    } else if (item.type === "error") {
      current.output = appendError(current.output, item.message);
    } else {
      continue;
    }
    if (Number.isFinite(at)) {
      current.completedAt = at;
    }
  }
  const turns: FinishedTurn[] = [];
  for (const [index, draft] of drafts.entries()) {
    const output = draft.output.trim();
    if (output === "") {
      continue;
    }
    const agentOutput = tail(output);
    turns.push({
      turn: {
        id: draft.id,
        dedupeKey: stableTextHash(`${draft.userInput ?? ""}\0${agentOutput}`),
        userInput: draft.userInput,
        agentOutput,
        outcome: "completed",
        completedAt: draft.completedAt,
        // A headless first draft can be the window cutting into a turn.
        contextIncomplete: index === 0 && draft.userInput === null && hasOlder !== false,
        declared: draft.finalReply.declared(),
        editCount: draft.editCount,
        reviewVerdict: draft.finalReply.reviewVerdict(),
      },
      subAgents: draft.subAgents,
    });
  }
  return turns.slice(-BACKFILL_TURNS);
}
