/**
 * Pure conversation model: timeline entries / stream events -> display rows.
 * Structural local types only (runtime code must not import @getpaseo/client|protocol).
 */

import {
  SESSION_CARD_KIND,
  SESSION_CARD_VERSION,
  SessionCardSchema,
  type SessionCard,
} from "../../shared/card";

export type TimelineItemLike = { type: string; [key: string]: unknown };

export type TodoEntry = { text: string; completed: boolean; inProgress: boolean };

export type Row =
  | { kind: "user"; key: string; text: string; messageId: string | null }
  | { kind: "assistant"; key: string; text: string; messageId: string | null }
  | { kind: "reasoning"; key: string; text: string }
  | {
      kind: "tool";
      key: string;
      callId: string;
      name: string;
      status: string;
      detail: unknown;
      error: unknown;
    }
  | { kind: "todo"; key: string; items: TodoEntry[] }
  | { kind: "session-card"; key: string; cardId: string; data: SessionCard }
  | { kind: "error"; key: string; message: string }
  | { kind: "note"; key: string; level: "info" | "warning" | "error" | "muted"; text: string };

export type FetchedEntry = {
  item: TimelineItemLike;
  seqStart?: number;
  seqEnd?: number;
};

export type ConversationState = {
  rows: Row[];
  /** Highest sequence number already reflected in `rows`. */
  lastSeq: number | null;
  epoch: string | null;
};

export const EMPTY_STATE: ConversationState = { rows: [], lastSeq: null, epoch: null };

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function rowKey(seq: number | undefined, counter: number): string {
  return seq === undefined ? `n${counter}` : `s${seq}`;
}

function todoEntries(value: unknown): TodoEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: TodoEntry[] = [];
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const entry = raw as Record<string, unknown>;
    const status = str(entry.status);
    result.push({
      text: str(entry.text) ?? str(entry.activeForm) ?? "",
      completed: entry.completed === true || status === "completed",
      inProgress: status === "in_progress",
    });
  }
  return result;
}

/** Appends one timeline item, merging streamed chunks and upserting tool calls. */
export function appendItem(rows: readonly Row[], item: TimelineItemLike, seq?: number): Row[] {
  const next = rows.slice();
  const key = rowKey(seq, next.length);
  const last = next[next.length - 1];
  switch (item.type) {
    case "user_message": {
      const messageId = str(item.messageId) ?? str(item.clientMessageId);
      const text = str(item.text) ?? "";
      if (messageId !== null && last?.kind === "user" && last.messageId === messageId) {
        next[next.length - 1] = { ...last, text: last.text === text ? text : last.text + text };
        return next;
      }
      next.push({ kind: "user", key, text, messageId });
      return next;
    }
    case "assistant_message": {
      const messageId = str(item.messageId);
      const text = str(item.text) ?? "";
      const sameMessage =
        last?.kind === "assistant" &&
        (messageId === null || last.messageId === null || last.messageId === messageId);
      if (last?.kind === "assistant" && sameMessage) {
        next[next.length - 1] = {
          ...last,
          text: last.text + text,
          messageId: last.messageId ?? messageId,
        };
        return next;
      }
      next.push({ kind: "assistant", key, text, messageId });
      return next;
    }
    case "reasoning": {
      const text = str(item.text) ?? "";
      if (last?.kind === "reasoning") {
        next[next.length - 1] = { ...last, text: last.text + text };
        return next;
      }
      next.push({ kind: "reasoning", key, text });
      return next;
    }
    case "tool_call": {
      const callId = str(item.callId) ?? key;
      const row: Row = {
        kind: "tool",
        key,
        callId,
        name: str(item.name) ?? "工具",
        status: str(item.status) ?? "running",
        detail: item.detail,
        error: item.error ?? null,
      };
      for (let index = next.length - 1; index >= 0; index -= 1) {
        const candidate = next[index];
        if (candidate?.kind === "tool" && candidate.callId === callId) {
          next[index] = { ...row, key: candidate.key };
          return next;
        }
      }
      next.push(row);
      return next;
    }
    case "todo": {
      const items = todoEntries(item.items);
      if (last?.kind === "todo") {
        next[next.length - 1] = { ...last, items };
        return next;
      }
      next.push({ kind: "todo", key, items });
      return next;
    }
    case "error":
      next.push({ kind: "error", key, message: str(item.message) ?? "发生错误" });
      return next;
    case "notification": {
      const level = item.level === "warning" || item.level === "error" ? item.level : "info";
      next.push({ kind: "note", key, level, text: str(item.message) ?? "" });
      return next;
    }
    case "compaction":
      next.push({
        kind: "note",
        key,
        level: "muted",
        text: item.status === "completed" ? "上下文已压缩" : "正在压缩上下文…",
      });
      return next;
    case "plugin": {
      if (item.kind === SESSION_CARD_KIND && item.version === SESSION_CARD_VERSION) {
        const parsed = SessionCardSchema.safeParse(item.data);
        if (parsed.success) {
          const cardId = `${str(item.pluginId) ?? ""}:${str(item.id) ?? key}`;
          for (let index = next.length - 1; index >= 0; index -= 1) {
            const candidate = next[index];
            if (candidate?.kind === "session-card" && candidate.cardId === cardId) {
              next[index] = { ...candidate, data: parsed.data };
              return next;
            }
          }
          next.push({ kind: "session-card", key, cardId, data: parsed.data });
          return next;
        }
      }
      next.push({ kind: "note", key, level: "muted", text: `插件事件 · ${str(item.kind) ?? item.type}` });
      return next;
    }
    default:
      next.push({ kind: "note", key, level: "muted", text: `插件事件 · ${item.type}` });
      return next;
  }
}

export function entriesToRows(entries: readonly FetchedEntry[]): Row[] {
  let rows: Row[] = [];
  for (const entry of entries) {
    rows = appendItem(rows, entry.item, entry.seqStart);
  }
  return rows;
}

export function stateFromFetch(
  entries: readonly FetchedEntry[],
  epoch: string | null,
): ConversationState {
  let lastSeq: number | null = null;
  for (const entry of entries) {
    const seq = entry.seqEnd ?? entry.seqStart;
    if (seq !== undefined && (lastSeq === null || seq > lastSeq)) {
      lastSeq = seq;
    }
  }
  return { rows: entriesToRows(entries), lastSeq, epoch };
}

/** Rows loaded for an older page go before the current ones. */
export function prependOlder(
  state: ConversationState,
  entries: readonly FetchedEntry[],
): ConversationState {
  const older = entriesToRows(entries);
  const seen = new Set(state.rows.map((row) => row.key));
  const fresh = older.filter((row) => !seen.has(row.key));
  return { ...state, rows: [...fresh, ...state.rows] };
}

export type StreamPayload = {
  seq?: number;
  epoch?: string;
  event?: { type?: string; item?: TimelineItemLike } & Record<string, unknown>;
};

export type MergeResult = { state: ConversationState; refetch: boolean; changed: boolean };

/** Merges one live `agent_stream` payload; duplicates (seq already seen) are ignored. */
export function mergeStreamEvent(state: ConversationState, payload: StreamPayload): MergeResult {
  const event = payload.event;
  if (!event || event.type !== "timeline" || !event.item) {
    return { state, refetch: false, changed: false };
  }
  if (payload.epoch !== undefined && state.epoch !== null && payload.epoch !== state.epoch) {
    return { state, refetch: true, changed: false };
  }
  const seq = payload.seq;
  if (seq !== undefined && state.lastSeq !== null && seq <= state.lastSeq) {
    // A re-appended plugin row can share a seen seq; still upsert it.
    if (event.item.type !== "plugin") {
      return { state, refetch: false, changed: false };
    }
    const replaced = appendItem(state.rows, event.item, seq);
    const updated = replaced.some(function differs(row, index) {
      return row !== state.rows[index];
    });
    return { state: updated ? { ...state, rows: replaced } : state, refetch: false, changed: updated };
  }
  const rows = appendItem(state.rows, event.item, seq);
  return {
    state: {
      rows,
      lastSeq: seq === undefined ? state.lastSeq : seq,
      epoch: state.epoch ?? payload.epoch ?? null,
    },
    refetch: false,
    changed: true,
  };
}

/** Fenced code segmentation for plain-text rendering. */
export type TextSegment = { code: boolean; text: string };

export function splitFences(text: string): TextSegment[] {
  const parts = text.split("```");
  const segments: TextSegment[] = [];
  parts.forEach((part, index) => {
    const code = index % 2 === 1;
    let body = part;
    if (code) {
      const newline = body.indexOf("\n");
      // Drop the language tag on the opening fence line.
      body = newline >= 0 ? body.slice(newline + 1) : body;
      body = body.replace(/\n$/, "");
    } else {
      body = body.replace(/^\n+|\n+$/g, "");
    }
    // An unterminated trailing fence is still shown as code while streaming.
    if (body !== "" || code) {
      segments.push({ code, text: body });
    }
  });
  return segments;
}

export const TOOL_TEXT_LIMIT = 4000;

/** Prefix of a steer message: tells the agent it is a supplement, not a new task. */
export const STEER_PREFIX =
  "[追加说明] 这是对当前任务的补充，不是替换：继续完成原目标，在本轮最终回复中一并体现，不要单独确认。";

/** The text sent for a steer (wording borrowed from Multica's additional guidance). */
export function steerText(text: string): string {
  return `${STEER_PREFIX}\n${text}`;
}

export function truncateText(value: string, limit: number = TOOL_TEXT_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}\n… 已截断（共 ${value.length} 字符）` : value;
}

export function stringifyForDisplay(value: unknown, limit: number = TOOL_TEXT_LIMIT): string {
  if (value === undefined || value === null) {
    return "";
  }
  if (typeof value === "string") {
    return truncateText(value, limit);
  }
  try {
    return truncateText(JSON.stringify(value, null, 2) ?? "", limit);
  } catch {
    return truncateText(String(value), limit);
  }
}

/** One-line summary of a tool call detail (command, path, query, ...). */
export function toolSummary(detail: unknown): string {
  if (typeof detail !== "object" || detail === null) {
    return "";
  }
  const d = detail as Record<string, unknown>;
  const pick = (value: unknown): string => (typeof value === "string" ? value : "");
  let summary = "";
  switch (d.type) {
    case "shell":
      summary = pick(d.command);
      break;
    case "read":
    case "edit":
    case "write":
      summary = pick(d.filePath);
      break;
    case "search":
      summary = pick(d.query);
      break;
    case "fetch":
      summary = pick(d.url);
      break;
    case "sub_agent":
      summary = pick(d.description) || pick(d.subAgentType);
      break;
    case "plain_text":
      summary = pick(d.label) || pick(d.text);
      break;
    case "plan":
      summary = "计划";
      break;
    default:
      summary = "";
  }
  return summary.replace(/\s+/g, " ").trim().slice(0, 140);
}

/** Expanded body of a tool call, truncated. */
export function toolBody(detail: unknown, error: unknown): string {
  const parts: string[] = [];
  const body = stringifyForDisplay(detail);
  if (body !== "") {
    parts.push(body);
  }
  if (error !== null && error !== undefined) {
    parts.push(`错误：${stringifyForDisplay(error, 1000)}`);
  }
  return parts.join("\n\n");
}

export type StickMetrics = { contentHeight: number; offsetY: number; viewportHeight: number };

/** True when the viewport is close enough to the bottom to keep following new content. */
export function isNearBottom(metrics: StickMetrics, threshold: number = 80): boolean {
  return metrics.contentHeight - (metrics.offsetY + metrics.viewportHeight) <= threshold;
}
