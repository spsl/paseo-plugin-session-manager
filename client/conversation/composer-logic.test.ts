import { describe, expect, it, vi } from "vitest";
import {
  applySlashCommandReplacement,
  buildSlashEntries,
  clampComposerHeight,
  composerMaxHeight,
  composerMinHeight,
  createComposerSubmitter,
  decideSubmit,
  findActiveSlashCommand,
  isImeComposing,
  keyIntent,
  nextModeId,
  placeholderFor,
  popoverKeyIntent,
  primaryAction,
  rankSlashEntries,
  resolveActiveSendBehavior,
  resolveThinkingOptionId,
  restoredDraft,
  turnBehaviorFor,
} from "./composer-logic";

describe("isImeComposing", () => {
  it("detects composing state and keyCode 229", () => {
    expect(isImeComposing({ isComposing: true })).toBe(true);
    expect(isImeComposing({ keyCode: 229 })).toBe(true);
    expect(isImeComposing({ key: "Enter" })).toBe(false);
    expect(isImeComposing({})).toBe(false);
  });
});

describe("resolveActiveSendBehavior", () => {
  it("degrades queue to interrupt while a permission is pending", () => {
    expect(resolveActiveSendBehavior("queue", true)).toBe("interrupt");
    expect(resolveActiveSendBehavior("queue", false)).toBe("queue");
    expect(resolveActiveSendBehavior("steer", true)).toBe("steer");
    expect(resolveActiveSendBehavior("interrupt", true)).toBe("interrupt");
  });
});

describe("turnBehaviorFor", () => {
  it("maps steer to steer and everything else to interrupt", () => {
    expect(turnBehaviorFor("steer")).toBe("steer");
    expect(turnBehaviorFor("interrupt")).toBe("interrupt");
    expect(turnBehaviorFor("queue")).toBe("interrupt");
  });
});

describe("decideSubmit", () => {
  it("default kind over 3 behaviors x running", () => {
    expect(decideSubmit("default", "steer", true)).toEqual({
      kind: "send",
      activeTurnBehavior: "steer",
    });
    expect(decideSubmit("default", "steer", false)).toEqual({
      kind: "send",
      activeTurnBehavior: "steer",
    });
    expect(decideSubmit("default", "interrupt", true)).toEqual({
      kind: "send",
      activeTurnBehavior: "interrupt",
    });
    expect(decideSubmit("default", "interrupt", false)).toEqual({
      kind: "send",
      activeTurnBehavior: "interrupt",
    });
    expect(decideSubmit("default", "queue", true)).toEqual({ kind: "queue" });
    expect(decideSubmit("default", "queue", false)).toEqual({
      kind: "send",
      activeTurnBehavior: "interrupt",
    });
  });

  it("alternate kind over 3 behaviors x running", () => {
    expect(decideSubmit("alternate", "steer", true)).toEqual({ kind: "queue" });
    expect(decideSubmit("alternate", "steer", false)).toEqual({ kind: "none" });
    expect(decideSubmit("alternate", "interrupt", true)).toEqual({ kind: "queue" });
    expect(decideSubmit("alternate", "interrupt", false)).toEqual({ kind: "none" });
    expect(decideSubmit("alternate", "queue", true)).toEqual({
      kind: "send",
      activeTurnBehavior: "interrupt",
    });
    expect(decideSubmit("alternate", "queue", false)).toEqual({
      kind: "send",
      activeTurnBehavior: "interrupt",
    });
  });
});

describe("primaryAction", () => {
  it("covers all states", () => {
    expect(primaryAction({ hasContent: true, running: false, sending: false })).toBe("send");
    expect(primaryAction({ hasContent: true, running: true, sending: false })).toBe("send");
    expect(primaryAction({ hasContent: false, running: true, sending: false })).toBe("stop");
    expect(primaryAction({ hasContent: false, running: false, sending: false })).toBe("none");
    // sending shows the send-slot spinner, not the stop button
    expect(primaryAction({ hasContent: false, running: false, sending: true })).toBe("send");
    expect(primaryAction({ hasContent: true, running: false, sending: true })).toBe("send");
  });
});

describe("keyIntent", () => {
  const base = {
    submitOnEnter: true,
    running: false,
    sending: false,
    stopping: false,
    canCycleMode: false,
  };

  it("ignores IME composition", () => {
    expect(keyIntent({ key: "Enter", isComposing: true }, base)).toBe("none");
    expect(keyIntent({ key: "Enter", keyCode: 229 }, base)).toBe("none");
  });

  it("Enter submits, Shift+Enter and narrow layout produce a newline", () => {
    expect(keyIntent({ key: "Enter" }, base)).toBe("submit-default");
    expect(keyIntent({ key: "Enter", shiftKey: true }, base)).toBe("newline");
    expect(keyIntent({ key: "Enter" }, { ...base, submitOnEnter: false })).toBe("newline");
    expect(keyIntent({ key: "Enter" }, { ...base, sending: true })).toBe("newline");
  });

  it("Cmd/Ctrl+Enter runs the alternate action only while running", () => {
    const running = { ...base, running: true };
    expect(keyIntent({ key: "Enter", metaKey: true }, running)).toBe("submit-alternate");
    expect(keyIntent({ key: "Enter", ctrlKey: true }, running)).toBe("submit-alternate");
    expect(keyIntent({ key: "Enter", metaKey: true }, base)).toBe("submit-default");
    expect(keyIntent({ key: "Enter", ctrlKey: true }, base)).toBe("submit-default");
    expect(keyIntent({ key: "Enter", metaKey: true, shiftKey: true }, running)).toBe("newline");
  });

  it("Esc interrupts only while running and not already stopping", () => {
    expect(keyIntent({ key: "Escape" }, { ...base, running: true })).toBe("interrupt");
    expect(keyIntent({ key: "Escape" }, base)).toBe("none");
    expect(
      keyIntent({ key: "Escape" }, { ...base, running: true, stopping: true }),
    ).toBe("none");
  });

  it("Shift+Tab cycles modes only when several exist", () => {
    expect(keyIntent({ key: "Tab", shiftKey: true }, { ...base, canCycleMode: true })).toBe(
      "cycle-mode",
    );
    expect(keyIntent({ key: "Tab", shiftKey: true }, base)).toBe("none");
    expect(keyIntent({ key: "Tab" }, { ...base, canCycleMode: true })).toBe("none");
  });
});

describe("height bounds", () => {
  it("composerMinHeight matches platform", () => {
    expect(composerMinHeight(true)).toBe(46);
    expect(composerMinHeight(false)).toBe(30);
  });

  it("composerMaxHeight is max(160, half the window)", () => {
    expect(composerMaxHeight(0)).toBe(160);
    expect(composerMaxHeight(200)).toBe(160);
    expect(composerMaxHeight(1000)).toBe(500);
    expect(composerMaxHeight(801)).toBe(400);
    expect(composerMaxHeight(NaN)).toBe(160);
  });

  it("clampComposerHeight clamps and survives NaN", () => {
    expect(clampComposerHeight(20, 46, 160)).toBe(46);
    expect(clampComposerHeight(300, 46, 160)).toBe(160);
    expect(clampComposerHeight(80, 46, 160)).toBe(80);
    expect(clampComposerHeight(NaN, 46, 160)).toBe(46);
  });
});

describe("findActiveSlashCommand", () => {
  it("matches at index 0 as start", () => {
    expect(findActiveSlashCommand("/exi", 4)).toEqual({
      start: 0,
      end: 4,
      query: "exi",
      position: "start",
    });
  });

  it("matches after whitespace as inline", () => {
    expect(findActiveSlashCommand("hello /ski", 10)).toEqual({
      start: 6,
      end: 10,
      query: "ski",
      position: "inline",
    });
    expect(findActiveSlashCommand("a\n/ex", 5)).toEqual({
      start: 2,
      end: 5,
      query: "ex",
      position: "inline",
    });
  });

  it("does not trigger after a non-whitespace char or with a dirty query", () => {
    expect(findActiveSlashCommand("foo/bar", 7)).toBeNull();
    expect(findActiveSlashCommand("/foo bar", 8)).toBeNull();
    expect(findActiveSlashCommand("/foo\nbar", 8)).toBeNull();
    expect(findActiveSlashCommand('a "b/c', 6)).toBeNull();
    expect(findActiveSlashCommand("no slash", 8)).toBeNull();
  });

  it("respects the cursor position", () => {
    expect(findActiveSlashCommand("/exit more", 3)).toEqual({
      start: 0,
      end: 3,
      query: "ex",
      position: "start",
    });
  });
});

describe("applySlashCommandReplacement", () => {
  it("replaces the match and appends a space at end of text", () => {
    expect(
      applySlashCommandReplacement("/exi", { start: 0, end: 4, query: "exi", position: "start" }, "exit"),
    ).toBe("/exit ");
    expect(
      applySlashCommandReplacement(
        "a /sk b",
        { start: 2, end: 5, query: "sk", position: "inline" },
        "skill",
      ),
    ).toBe("a /skill b");
  });
});

describe("nextModeId", () => {
  const modes = [{ id: "a" }, { id: "b" }, { id: "c" }];
  it("cycles forward and wraps", () => {
    expect(nextModeId(modes, "a")).toBe("b");
    expect(nextModeId(modes, "c")).toBe("a");
    expect(nextModeId(modes, null)).toBe("a");
    expect(nextModeId(modes, "unknown")).toBe("a");
    expect(nextModeId([], "a")).toBeNull();
  });
});

describe("placeholderFor", () => {
  it("only advertises implemented capabilities", () => {
    expect(placeholderFor({ compact: false, slash: true, mentions: false })).toBe(
      "给 Agent 发消息，或使用 /commands 和 /skills",
    );
    expect(placeholderFor({ compact: false, slash: true, mentions: true })).toBe(
      "给 Agent 发消息，标记 @files，或使用 /commands 和 /skills",
    );
    expect(placeholderFor({ compact: false, slash: false, mentions: false })).toBe("输入消息...");
    expect(placeholderFor({ compact: true, slash: true, mentions: false })).toBe(
      "发消息，/commands",
    );
    expect(placeholderFor({ compact: true, slash: false, mentions: false })).toBe("发消息");
  });
});

describe("restoredDraft", () => {
  it("restores failed text or prepends it without clobbering", () => {
    expect(restoredDraft("", "失败文本")).toBe("失败文本");
    expect(restoredDraft("   ", "失败文本")).toBe("失败文本");
    expect(restoredDraft("新输入", "失败文本")).toBe("失败文本\n新输入");
  });
});

describe("createComposerSubmitter", () => {
  function makeEffects() {
    return {
      clearInput: vi.fn(),
      queueMessage: vi.fn(),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      archive: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("sends with the behavior's turn behavior", async () => {
    const effects = makeEffects();
    const submitter = createComposerSubmitter(effects);
    const outcome = await submitter.submit({
      kind: "default",
      running: true,
      hasPendingPermission: false,
      behavior: "steer",
      text: "  你好  ",
      images: [],
    });
    expect(outcome).toBe("sent");
    expect(effects.sendMessage).toHaveBeenCalledWith("你好", {
      activeTurnBehavior: "steer",
    });
    expect(effects.clearInput).toHaveBeenCalledTimes(1);
  });

  it("queues when behavior is queue and agent runs", async () => {
    const effects = makeEffects();
    const submitter = createComposerSubmitter(effects);
    const outcome = await submitter.submit({
      kind: "default",
      running: true,
      hasPendingPermission: false,
      behavior: "queue",
      text: "排队",
      images: [],
    });
    expect(outcome).toBe("queued");
    expect(effects.queueMessage).toHaveBeenCalledWith({ text: "排队", images: [] });
    expect(effects.sendMessage).not.toHaveBeenCalled();
  });

  it("archives on /exit, /quit, /q", async () => {
    for (const text of ["/exit", " /quit ", "/q"]) {
      const effects = makeEffects();
      const submitter = createComposerSubmitter(effects);
      const outcome = await submitter.submit({
        kind: "default",
        running: false,
        hasPendingPermission: false,
        behavior: "steer",
        text,
        images: [],
      });
      expect(outcome).toBe("archived");
      expect(effects.archive).toHaveBeenCalledTimes(1);
      expect(effects.sendMessage).not.toHaveBeenCalled();
    }
  });

  it("a second submit while in flight is dropped", async () => {
    const effects = makeEffects();
    const releaseRef: { fn: (() => void) | null } = { fn: null };
    effects.sendMessage.mockImplementation(
      () =>
        new Promise<void>(function hold(resolve) {
          releaseRef.fn = resolve;
        }),
    );
    const submitter = createComposerSubmitter(effects);
    const first = submitter.submit({
      kind: "default",
      running: false,
      hasPendingPermission: false,
      behavior: "steer",
      text: "一",
      images: [],
    });
    const second = await submitter.submit({
      kind: "default",
      running: false,
      hasPendingPermission: false,
      behavior: "steer",
      text: "二",
      images: [],
    });
    expect(second).toBe("none");
    releaseRef.fn?.();
    expect(await first).toBe("sent");
    expect(effects.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends images as bare {data, mimeType} pairs", async () => {
    const effects = makeEffects();
    const submitter = createComposerSubmitter(effects);
    const image = {
      id: "i1",
      mimeType: "image/png",
      data: "QUJD",
      uri: "data:image/png;base64,QUJD",
    };
    const outcome = await submitter.submit({
      kind: "default",
      running: false,
      hasPendingPermission: false,
      behavior: "steer",
      text: "图",
      images: [image],
    });
    expect(outcome).toBe("sent");
    expect(effects.sendMessage).toHaveBeenCalledWith("图", {
      activeTurnBehavior: "steer",
      images: [{ data: "QUJD", mimeType: "image/png" }],
    });
  });

  it("sendNow sends images as bare {data, mimeType} pairs", async () => {
    const effects = makeEffects();
    const submitter = createComposerSubmitter(effects);
    const image = {
      id: "i1",
      mimeType: "image/png",
      data: "QUJD",
      uri: "data:image/png;base64,QUJD",
    };
    const outcome = await submitter.sendNow({
      text: "排队项",
      images: [image],
      activeTurnBehavior: "interrupt",
    });
    expect(outcome).toBe("sent");
    expect(effects.sendMessage).toHaveBeenCalledWith("排队项", {
      activeTurnBehavior: "interrupt",
      images: [{ data: "QUJD", mimeType: "image/png" }],
    });
  });

  it("sendNow shares the same in-flight guard", async () => {
    const effects = makeEffects();
    const releaseRef: { fn: (() => void) | null } = { fn: null };
    effects.sendMessage.mockImplementation(
      () =>
        new Promise<void>(function hold(resolve) {
          releaseRef.fn = resolve;
        }),
    );
    const submitter = createComposerSubmitter(effects);
    const first = submitter.submit({
      kind: "default",
      running: false,
      hasPendingPermission: false,
      behavior: "steer",
      text: "一",
      images: [],
    });
    const second = await submitter.sendNow({
      text: "排队项",
      images: [],
      activeTurnBehavior: "interrupt",
    });
    expect(second).toBe("none");
    releaseRef.fn?.();
    await first;
    expect(effects.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("archiveNow archives immediately and shares the in-flight guard", async () => {
    const effects = makeEffects();
    const submitter = createComposerSubmitter(effects);
    expect(await submitter.archiveNow()).toBe("archived");
    expect(effects.archive).toHaveBeenCalledTimes(1);
    expect(effects.clearInput).toHaveBeenCalledTimes(1);

    const heldEffects = makeEffects();
    const releaseRef: { fn: (() => void) | null } = { fn: null };
    heldEffects.sendMessage.mockImplementation(
      () =>
        new Promise<void>(function hold(resolve) {
          releaseRef.fn = resolve;
        }),
    );
    const busy = createComposerSubmitter(heldEffects);
    const first = busy.submit({
      kind: "default",
      running: false,
      hasPendingPermission: false,
      behavior: "steer",
      text: "一",
      images: [],
    });
    expect(await busy.archiveNow()).toBe("none");
    releaseRef.fn?.();
    await first;
    expect(heldEffects.archive).not.toHaveBeenCalled();
  });
});

type Command = {
  name: string;
  description: string;
  argumentHint: string;
  kind?: "command" | "skill";
};

function commandsResult(commands: Command[], error: string | null = null) {
  return { agentId: "a", commands, error, requestId: "r" } as never;
}

describe("buildSlashEntries", () => {
  it("puts builtin /exit first and drops provider collisions", () => {
    const entries = buildSlashEntries(
      commandsResult([
        { name: "review", description: "Review code", argumentHint: "" },
        { name: "quit", description: "provider quit", argumentHint: "" },
      ]),
    );
    expect(entries).not.toBeNull();
    expect(entries?.[0].name).toBe("exit");
    expect(entries?.[0].aliases).toEqual(["quit", "q"]);
    expect(entries?.map(function name(e) { return e.name; })).toEqual(["exit", "review"]);
  });

  it("returns null on a provider error", () => {
    expect(buildSlashEntries(commandsResult([], "provider down"))).toBeNull();
    expect(buildSlashEntries(commandsResult([]))).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "exit" })]),
    );
  });
});

describe("rankSlashEntries", () => {
  const entries = buildSlashEntries(
    commandsResult([
      {
        name: "ask",
        description: "Answer a quick question about the codebase",
        argumentHint: "<question>",
        kind: "skill",
      },
      { name: "review", description: "Review code", argumentHint: "" },
    ]),
  );
  const start = (query: string) => ({
    start: 0,
    end: query.length + 1,
    query,
    position: "start" as const,
  });
  const inline = (query: string, startAt: number, end: number) => ({
    start: startAt,
    end,
    query,
    position: "inline" as const,
  });

  it("/q and /quit resolve to the builtin exit through its aliases", () => {
    if (entries === null) {
      throw new Error("entries");
    }
    expect(rankSlashEntries(entries, start("q"))[0].name).toBe("exit");
    expect(rankSlashEntries(entries, start("quit"))[0].name).toBe("exit");
    expect(rankSlashEntries(entries, start("exit"))[0].name).toBe("exit");
  });

  it("never scores the description — a fuzzy hit there does not surface", () => {
    if (entries === null) {
      throw new Error("entries");
    }
    // "quick question" lives only in ask's description; /q must not rank it.
    const ranked = rankSlashEntries(entries, start("q"));
    expect(ranked.map(function name(e) { return e.name; })).toEqual(["exit"]);
    expect(
      rankSlashEntries(entries, start("quest")).map(function name(e) {
        return e.name;
      }),
    ).toEqual([]);
  });

  it("inline position only offers provider skills", () => {
    if (entries === null) {
      throw new Error("entries");
    }
    const match = inline("a", 6, 7);
    const ranked = rankSlashEntries(entries, match);
    expect(ranked.every(function skill(e) { return e.source === "provider" && e.kind === "skill"; })).toBe(
      true,
    );
  });

  it("empty query keeps the entry order", () => {
    if (entries === null) {
      throw new Error("entries");
    }
    const ranked = rankSlashEntries(entries, start(""));
    expect(ranked[0].name).toBe("exit");
    expect(ranked).toHaveLength(3);
  });
});

describe("popoverKeyIntent", () => {
  it("ignores IME composition before anything else", () => {
    expect(popoverKeyIntent({ key: "Enter", isComposing: true })).toBe("none");
    expect(popoverKeyIntent({ key: "ArrowDown", keyCode: 229 })).toBe("none");
    expect(popoverKeyIntent({ key: "ArrowUp", isComposing: true })).toBe("none");
  });

  it("moves, accepts and dismisses", () => {
    expect(popoverKeyIntent({ key: "ArrowDown" })).toBe("down");
    expect(popoverKeyIntent({ key: "ArrowUp" })).toBe("up");
    expect(popoverKeyIntent({ key: "Enter" })).toBe("accept");
    expect(popoverKeyIntent({ key: "Tab" })).toBe("accept");
    expect(popoverKeyIntent({ key: "Escape" })).toBe("dismiss");
  });

  it("modified Enter falls through to normal key handling", () => {
    expect(popoverKeyIntent({ key: "Enter", metaKey: true })).toBe("none");
    expect(popoverKeyIntent({ key: "Enter", ctrlKey: true })).toBe("none");
    expect(popoverKeyIntent({ key: "Enter", shiftKey: true })).toBe("none");
    expect(popoverKeyIntent({ key: "x" })).toBe("none");
  });
});

describe("resolveThinkingOptionId", () => {
  const options = [{ id: "low" }, { id: "high" }];

  it("prefers the runtime option, then explicit, then model default, then first", () => {
    expect(
      resolveThinkingOptionId(
        { effectiveThinkingOptionId: "high", thinkingOptionId: "low" },
        "low",
        options,
      ),
    ).toBe("high");
    expect(
      resolveThinkingOptionId(
        { effectiveThinkingOptionId: null, thinkingOptionId: "low" },
        "high",
        options,
      ),
    ).toBe("low");
    expect(
      resolveThinkingOptionId(
        { effectiveThinkingOptionId: null, thinkingOptionId: "default" },
        "high",
        options,
      ),
    ).toBe("high");
    expect(
      resolveThinkingOptionId({ thinkingOptionId: null }, null, options),
    ).toBe("low");
    expect(resolveThinkingOptionId({}, null, [])).toBeNull();
  });
});
