import { describe, expect, it } from "vitest";
import {
  appendItem,
  entriesToRows,
  isNearBottom,
  mergeStreamEvent,
  prependOlder,
  splitFences,
  stateFromFetch,
  toolBody,
  toolSummary,
  truncateText,
  type Row,
} from "./model";
import { pendingTurnCard, supersededTurnCard, SESSION_CARD_KIND, SESSION_CARD_VERSION } from "../../shared/card";
import { extractChoices, permissionView, responseFor, visiblePermissions } from "./permissions";

describe("appendItem", () => {
  it("merges consecutive assistant chunks and keeps the first key", () => {
    let rows: Row[] = [];
    rows = appendItem(rows, { type: "assistant_message", text: "你" }, 1);
    rows = appendItem(rows, { type: "assistant_message", text: "好" }, 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "assistant", text: "你好", key: "s1" });
  });

  it("does not merge assistant messages with different ids or across other rows", () => {
    let rows: Row[] = [];
    rows = appendItem(rows, { type: "assistant_message", text: "a", messageId: "1" }, 1);
    rows = appendItem(rows, { type: "assistant_message", text: "b", messageId: "2" }, 2);
    rows = appendItem(rows, { type: "tool_call", callId: "c", name: "Bash", status: "running" }, 3);
    rows = appendItem(rows, { type: "assistant_message", text: "c", messageId: "2" }, 4);
    expect(rows.map((row) => row.kind)).toEqual(["assistant", "assistant", "tool", "assistant"]);
  });

  it("upserts tool calls by callId", () => {
    let rows: Row[] = [];
    rows = appendItem(rows, { type: "tool_call", callId: "c", name: "Bash", status: "running" }, 1);
    rows = appendItem(rows, { type: "assistant_message", text: "x" }, 2);
    rows = appendItem(rows, { type: "tool_call", callId: "c", name: "Bash", status: "completed" }, 3);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ kind: "tool", status: "completed", key: "s1" });
  });

  it("replaces a trailing todo snapshot and maps statuses", () => {
    let rows: Row[] = [];
    rows = appendItem(rows, { type: "todo", items: [{ text: "a", completed: false }] }, 1);
    rows = appendItem(
      rows,
      { type: "todo", items: [{ text: "a", completed: true }, { text: "b", completed: false, status: "in_progress" }] },
      2,
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.kind === "todo" && row.items.map((item) => [item.completed, item.inProgress])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("maps errors, notifications, compaction and unknown items", () => {
    let rows: Row[] = [];
    rows = appendItem(rows, { type: "error", message: "boom" }, 1);
    rows = appendItem(rows, { type: "notification", level: "warning", message: "w" }, 2);
    rows = appendItem(rows, { type: "compaction", status: "completed" }, 3);
    rows = appendItem(rows, { type: "plugin", kind: "k" }, 4);
    expect(rows.map((row) => row.kind)).toEqual(["error", "note", "note", "note"]);
    expect(rows[3]).toMatchObject({ text: "插件事件 · k" });
  });

  it("maps session-manager plugin rows to cards and upserts them by id", () => {
    const card = pendingTurnCard();
    let rows: Row[] = [];
    rows = appendItem(
      rows,
      { type: "plugin", id: "t1", pluginId: "session-manager", kind: SESSION_CARD_KIND, version: SESSION_CARD_VERSION, data: card },
      1,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "session-card", cardId: "session-manager:t1" });
    rows = appendItem(
      rows,
      { type: "plugin", id: "t1", pluginId: "session-manager", kind: SESSION_CARD_KIND, version: SESSION_CARD_VERSION, data: supersededTurnCard() },
      2,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "session-card", data: { state: "superseded" } });
  });

  it("falls back to a note when card data fails the schema", () => {
    const rows = appendItem(
      [],
      { type: "plugin", id: "t1", kind: SESSION_CARD_KIND, version: SESSION_CARD_VERSION, data: { nope: 1 } },
      1,
    );
    expect(rows[0]).toMatchObject({ kind: "note", text: `插件事件 · ${SESSION_CARD_KIND}` });
  });
});

describe("stream merging", () => {
  const base = stateFromFetch(
    [
      { item: { type: "user_message", text: "hi" }, seqStart: 1, seqEnd: 1 },
      { item: { type: "assistant_message", text: "he" }, seqStart: 2, seqEnd: 3 },
    ],
    "e1",
  );

  it("tracks the last seq from a fetch", () => {
    expect(base.lastSeq).toBe(3);
    expect(base.rows).toHaveLength(2);
  });

  it("appends new events and ignores duplicates", () => {
    const payload = { seq: 4, epoch: "e1", event: { type: "timeline", item: { type: "assistant_message", text: "llo" } } };
    const first = mergeStreamEvent(base, payload);
    expect(first.changed).toBe(true);
    expect(first.state.rows[1]).toMatchObject({ text: "hello" });
    const again = mergeStreamEvent(first.state, payload);
    expect(again.changed).toBe(false);
    expect(again.state).toBe(first.state);
  });

  it("requests a refetch on epoch change and ignores non-timeline events", () => {
    const changed = mergeStreamEvent(base, {
      seq: 9,
      epoch: "e2",
      event: { type: "timeline", item: { type: "assistant_message", text: "x" } },
    });
    expect(changed.refetch).toBe(true);
    const other = mergeStreamEvent(base, { seq: 9, epoch: "e1", event: { type: "turn_completed" } });
    expect(other).toMatchObject({ refetch: false, changed: false });
  });

  it("prepends older rows without duplicating keys", () => {
    const older = [{ item: { type: "user_message", text: "old" }, seqStart: 0, seqEnd: 0 }];
    const merged = prependOlder(base, older);
    expect(merged.rows).toHaveLength(3);
    expect(merged.rows[0]).toMatchObject({ text: "old" });
    expect(prependOlder(merged, older).rows).toHaveLength(3);
    expect(entriesToRows(older)).toHaveLength(1);
  });
});

describe("text helpers", () => {
  it("splits fenced code", () => {
    expect(splitFences("a\n```ts\nconst x = 1;\n```\nb")).toEqual([
      { code: false, text: "a" },
      { code: true, text: "const x = 1;" },
      { code: false, text: "b" },
    ]);
    expect(splitFences("plain")).toEqual([{ code: false, text: "plain" }]);
    expect(splitFences("x\n```\nopen")).toEqual([
      { code: false, text: "x" },
      { code: true, text: "open" },
    ]);
  });

  it("truncates and summarizes tool details", () => {
    expect(truncateText("a".repeat(5000)).length).toBeLessThan(4100);
    expect(toolSummary({ type: "shell", command: "ls  -la\n" })).toBe("ls -la");
    expect(toolSummary({ type: "read", filePath: "/a/b" })).toBe("/a/b");
    expect(toolSummary(null)).toBe("");
    expect(toolBody({ type: "shell", command: "ls" }, "bad")).toContain("错误");
  });

  it("decides stick-to-bottom", () => {
    expect(isNearBottom({ contentHeight: 1000, offsetY: 520, viewportHeight: 400 })).toBe(true);
    expect(isNearBottom({ contentHeight: 1000, offsetY: 100, viewportHeight: 400 })).toBe(false);
  });
});

describe("permissions", () => {
  it("falls back to allow/deny and maps responses", () => {
    const view = permissionView({ id: "p", kind: "tool", name: "Bash", detail: { type: "shell", command: "rm x" } });
    expect(view.heading).toBe("工具调用 · Bash");
    expect(view.body).toBe("rm x");
    expect(view.choices.map((choice) => choice.behavior)).toEqual(["allow", "deny"]);
    expect(responseFor(view.choices[0]!)).toEqual({ behavior: "allow" });
    expect(responseFor(view.choices[1]!).behavior).toBe("deny");
  });

  it("uses explicit actions with selectedActionId", () => {
    const choices = extractChoices([
      { id: "a1", label: "实施", behavior: "allow", variant: "primary" },
      { id: "a2", label: "否", behavior: "deny" },
      { id: "bad" },
    ]);
    expect(choices).toHaveLength(2);
    expect(responseFor(choices[0]!)).toEqual({ behavior: "allow", selectedActionId: "a1" });
    expect(responseFor(choices[1]!)).toEqual({ behavior: "deny", selectedActionId: "a2" });
  });

  it("hides answered requests", () => {
    expect(visiblePermissions([{ id: "a" }, { id: "b" }], new Set(["a"]))).toEqual([{ id: "b" }]);
  });
});
