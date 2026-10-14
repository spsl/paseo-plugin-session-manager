/** Pure helpers turning Paseo timelines into analyzer turns. */
import {
  DECLARED_TEXT_MAX_LENGTH,
  type Declared,
  type DeclaredKind,
  type Turn,
} from "../shared/types";
import type { AgentTimelineItem } from "./host-types";

export const MAX_TEXT_LENGTH = 16_000;
export const BACKFILL_TURNS = 5;

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
}

export type TurnOutcomeInput =
  | { kind: "completed" }
  | { kind: "failed"; error: { message: string } }
  | { kind: "canceled" };

/** Builds the turn that just ended, or null when it should not be recorded. */
export function turnFromTurnEnded(
  timeline: readonly AgentTimelineItem[],
  outcome: TurnOutcomeInput,
  turnId: string | null,
  now: number,
): Turn | null {
  if (outcome.kind === "canceled") {
    return null;
  }
  let userIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (item.type === "user_message" && item.text.trim() !== "") {
      userIndex = index;
      break;
    }
  }
  const userInput = userIndex >= 0 ? head((timeline[userIndex] as { text: string }).text.trim()) : null;
  let output = "";
  const finalReply = new FinalReply();
  for (let index = userIndex + 1; index < timeline.length; index += 1) {
    const item = timeline[index];
    finalReply.add(item);
    if (item.type === "assistant_message") {
      output = joinText(output, item.text);
    } else if (item.type === "error") {
      output = appendError(output, item.message);
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
    id: turnId ?? `h:${dedupeKey}`,
    dedupeKey,
    userInput,
    agentOutput: output,
    outcome: outcome.kind,
    completedAt: now,
    contextIncomplete: userIndex < 0,
    declared: outcome.kind === "completed" ? finalReply.declared() : null,
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
  userInput: string;
  output: string;
  completedAt: number;
  finalReply: FinalReply;
};

/** Groups timeline entries (oldest first) into turns; each user_message starts one. */
export function turnsFromTimelineEntries(entries: readonly BackfillEntry[]): Turn[] {
  const drafts: Draft[] = [];
  let current: Draft | null = null;
  for (const entry of entries) {
    const item = entry.item;
    const at = Date.parse(entry.timestamp);
    if (item.type === "user_message") {
      if (item.text.trim() === "") {
        continue;
      }
      current = {
        id: entry.turnId ?? `seq:${entry.seqStart}`,
        userInput: head(item.text.trim()),
        output: "",
        completedAt: Number.isFinite(at) ? at : 0,
        finalReply: new FinalReply(),
      };
      drafts.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    current.finalReply.add(item);
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
  const turns: Turn[] = [];
  for (const draft of drafts) {
    const output = draft.output.trim();
    if (output === "") {
      continue;
    }
    const agentOutput = tail(output);
    turns.push({
      id: draft.id,
      dedupeKey: stableTextHash(`${draft.userInput}\0${agentOutput}`),
      userInput: draft.userInput,
      agentOutput,
      outcome: "completed",
      completedAt: draft.completedAt,
      contextIncomplete: false,
      declared: draft.finalReply.declared(),
    });
  }
  return turns.slice(-BACKFILL_TURNS);
}
