/**
 * Pure composer logic, mirroring Paseo's composer semantics: send-behavior
 * resolution, submit decisions, primary-button state, key intents, autogrow
 * bounds, slash-command matching and mode cycling.
 * No React, no DOM, no async arrows (Hermes).
 */
import { searchEntries } from "../../shared/model-search";
import { imagesOption, type ComposerImage } from "./composer-images";
import type { AgentHandle } from "./use-conversation";

export type SendBehavior = "interrupt" | "steer" | "queue";
export type ActiveTurnBehavior = "interrupt" | "steer";
export type PrimaryAction = "send" | "stop" | "none";
export type SubmitKind = "default" | "alternate";
export type SubmitDecision =
  | { kind: "queue" }
  | { kind: "send"; activeTurnBehavior: ActiveTurnBehavior }
  | { kind: "none" };

export type KeyInfo = {
  key?: string;
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

export type KeyIntent =
  | "submit-default"
  | "submit-alternate"
  | "interrupt"
  | "cycle-mode"
  | "newline"
  | "none";

/** Paseo: Boolean(e.isComposing) || 229 === e.keyCode. */
export function isImeComposing(e: KeyInfo): boolean {
  return Boolean(e.isComposing) || e.keyCode === 229;
}

/** "queue" degrades to "interrupt" while a permission request waits. */
export function resolveActiveSendBehavior(
  behavior: SendBehavior,
  hasPendingPermission: boolean,
): SendBehavior {
  return behavior === "queue" && hasPendingPermission ? "interrupt" : behavior;
}

/** Paseo: "steer" === sendBehavior ? "steer" : "interrupt". */
export function turnBehaviorFor(behavior: SendBehavior): ActiveTurnBehavior {
  return behavior === "steer" ? "steer" : "interrupt";
}

/**
 * default: queue only when the (resolved) behavior is "queue" and the agent is
 * running; otherwise send with the behavior's turn behavior.
 * alternate: "queue" behavior sends immediately (interrupt); otherwise running
 * queues, idle does nothing.
 */
export function decideSubmit(
  kind: SubmitKind,
  behavior: SendBehavior,
  running: boolean,
): SubmitDecision {
  if (kind === "default") {
    if (behavior === "queue" && running) {
      return { kind: "queue" };
    }
    return { kind: "send", activeTurnBehavior: turnBehaviorFor(behavior) };
  }
  if (behavior === "queue") {
    return { kind: "send", activeTurnBehavior: "interrupt" };
  }
  return running ? { kind: "queue" } : { kind: "none" };
}

/** Paseo §5.0.3: content -> send; empty+sending -> spinner (send slot); running -> stop. */
export function primaryAction(state: {
  hasContent: boolean;
  running: boolean;
  sending: boolean;
}): PrimaryAction {
  if (state.hasContent || state.sending) {
    return "send";
  }
  if (state.running) {
    return "stop";
  }
  return "none";
}

/**
 * Key handling for the composer input. The caller only reaches this when the
 * autocomplete popover is closed. `submitOnEnter` is web && !compact.
 */
export function keyIntent(
  e: KeyInfo,
  ctx: { submitOnEnter: boolean; running: boolean; sending: boolean; canCycleMode: boolean },
): KeyIntent {
  if (isImeComposing(e)) {
    return "none";
  }
  if (e.key === "Escape") {
    return ctx.running ? "interrupt" : "none";
  }
  if (e.key === "Tab" && e.shiftKey === true) {
    return ctx.canCycleMode ? "cycle-mode" : "none";
  }
  if (e.key !== "Enter") {
    return "none";
  }
  if (e.shiftKey === true || !ctx.submitOnEnter || ctx.sending) {
    return "newline";
  }
  if (e.metaKey === true || e.ctrlKey === true) {
    return ctx.running ? "submit-alternate" : "submit-default";
  }
  return "submit-default";
}

export function composerMinHeight(isWeb: boolean): number {
  return isWeb ? 46 : 30;
}

export function composerMaxHeight(windowHeight: number): number {
  const half = Number.isFinite(windowHeight) ? Math.floor(windowHeight * 0.5) : 0;
  return Math.max(160, half);
}

export function clampComposerHeight(measured: number, min: number, max: number): number {
  if (!Number.isFinite(measured)) {
    return min;
  }
  return Math.min(max, Math.max(min, measured));
}

export type SlashMatch = {
  start: number;
  end: number;
  query: string;
  position: "start" | "inline";
};

/** A query containing any of these can never be a slash command. */
const SLASH_QUERY_REJECT = /[/\s\n\r\t"']/;

/**
 * Ported from Paseo `findActiveSlashCommand`: scans backwards over every "/"
 * before the cursor; a "/" preceded by a non-whitespace char is skipped, and
 * the first candidate whose query stays clean wins. "start" only when the
 * slash sits at index 0; anything else is "inline".
 */
export function findActiveSlashCommand(text: string, cursor: number): SlashMatch | null {
  const end = Math.max(0, Math.min(cursor, text.length));
  const before = text.slice(0, end);
  for (
    let s = before.lastIndexOf("/");
    s >= 0;
    s = s === 0 ? -1 : before.lastIndexOf("/", s - 1)
  ) {
    const prev = s > 0 ? text[s - 1] : "";
    if (prev !== "" && !/\s/.test(prev)) {
      continue;
    }
    const query = before.slice(s + 1);
    if (!SLASH_QUERY_REJECT.test(query)) {
      return { start: s, end, query, position: s === 0 ? "start" : "inline" };
    }
  }
  return null;
}

/** Paseo `applySlashCommandReplacement`: replaces the match, trailing space at end. */
export function applySlashCommandReplacement(
  text: string,
  match: SlashMatch,
  name: string,
): string {
  const next = `${text.slice(0, match.start)}/${name}${text.slice(match.end)}`;
  return match.end === text.length ? `${next} ` : next;
}

/** Shift+Tab cycles to the next mode; unknown current id picks the first. */
export function nextModeId(
  modes: readonly { id: string }[],
  currentId: string | null,
): string | null {
  if (modes.length === 0) {
    return null;
  }
  const index = modes.findIndex(function match(mode) {
    return mode.id === currentId;
  });
  return modes[(index + 1) % modes.length].id;
}

/** Paseo zhCN placeholder strings, minus capabilities we do not ship. */
export function placeholderFor(opts: {
  compact: boolean;
  slash: boolean;
  mentions: boolean;
}): string {
  if (opts.compact) {
    const parts: string[] = [];
    if (opts.mentions) {
      parts.push("@files");
    }
    if (opts.slash) {
      parts.push("/commands");
    }
    return parts.length === 0 ? "发消息" : `发消息，${parts.join("，")}`;
  }
  if (opts.slash && opts.mentions) {
    return "给 Agent 发消息，标记 @files，或使用 /commands 和 /skills";
  }
  if (opts.slash) {
    return "给 Agent 发消息，或使用 /commands 和 /skills";
  }
  if (opts.mentions) {
    return "给 Agent 发消息，标记 @files";
  }
  return "输入消息...";
}

/**
 * Restores the failed text without clobbering what the user typed meanwhile:
 * empty current -> failed text back; otherwise the failed text goes in front.
 */
export function restoredDraft(current: string, failed: string): string {
  return current.trim() === "" ? failed : `${failed}\n${current}`;
}

export type SlashCommandEntry = {
  name: string;
  description: string;
  argumentHint: string;
  kind: "command" | "skill" | null;
  source: "builtin" | "provider";
};

type CommandsResult = Awaited<ReturnType<AgentHandle["commands"]>>;

const EXIT_ENTRY: SlashCommandEntry = {
  name: "exit",
  description: "归档此会话",
  argumentHint: "",
  kind: "command",
  source: "builtin",
};

/**
 * The completion list shown at position "start": builtin /exit first, then
 * every provider command. Inline matches only offer provider skills, like
 * Paseo's filterInlineSkillCommandEntries. Returns null when the provider
 * could not answer (result.error), which also hides the popover.
 */
export function buildSlashEntries(result: CommandsResult): SlashCommandEntry[] | null {
  if (typeof result.error === "string" && result.error !== "") {
    return null;
  }
  const provider = (result.commands ?? []).map(function toEntry(command) {
    return {
      name: command.name,
      description: command.description,
      argumentHint: command.argumentHint,
      kind: command.kind === "skill" ? ("skill" as const) : ("command" as const),
      source: "provider" as const,
    };
  });
  return [EXIT_ENTRY, ...provider];
}

/** Filters the entry list by match position and ranks it against the query. */
export function rankSlashEntries(
  entries: readonly SlashCommandEntry[],
  match: SlashMatch,
): SlashCommandEntry[] {
  const candidates =
    match.position === "start"
      ? entries
      : entries.filter(function onlySkills(entry) {
          return entry.source === "provider" && entry.kind === "skill";
        });
  return searchEntries(
    candidates.map(function toSearch(entry) {
      return { ...entry, id: entry.name, label: `/${entry.name}`, provider: entry.description };
    }),
    match.query,
  );
}

export type SendImages = NonNullable<ReturnType<typeof imagesOption>["images"]>;

export type ComposerSubmitInput = {
  kind: SubmitKind;
  running: boolean;
  hasPendingPermission: boolean;
  behavior: SendBehavior;
  text: string;
  images: readonly ComposerImage[];
};

export type ComposerSubmitEffects = {
  /** Runs synchronously once the submit commits to queue or send (optimistic clear). */
  clearInput(): void;
  queueMessage(input: { text: string; images: readonly ComposerImage[] }): void;
  sendMessage(
    text: string,
    options: { activeTurnBehavior: ActiveTurnBehavior; images?: SendImages },
  ): Promise<void>;
  archive(): Promise<void>;
};

export type SubmitOutcome = "sent" | "queued" | "archived" | "none";

const EXIT_COMMANDS = new Set(["/exit", "/quit", "/q"]);

/**
 * The submit pipeline behind the composer's Enter / send button / "立即发送".
 * `held` is the synchronous double-submit guard (submittingRef semantics):
 * set before the first await, reset in finally.
 */
export function createComposerSubmitter(effects: ComposerSubmitEffects): {
  submit(input: ComposerSubmitInput): Promise<SubmitOutcome>;
  sendNow(input: {
    text: string;
    images: readonly ComposerImage[];
    activeTurnBehavior: ActiveTurnBehavior;
  }): Promise<"sent" | "none">;
} {
  let held = false;
  return {
    async submit(input: ComposerSubmitInput): Promise<SubmitOutcome> {
      if (held) {
        return "none";
      }
      const text = input.text.trim();
      const images = input.images;
      if (text === "" && images.length === 0) {
        return "none";
      }
      if (images.length === 0 && EXIT_COMMANDS.has(text)) {
        held = true;
        try {
          effects.clearInput();
          await effects.archive();
          return "archived";
        } finally {
          held = false;
        }
      }
      const behavior = resolveActiveSendBehavior(input.behavior, input.hasPendingPermission);
      const decision = decideSubmit(input.kind, behavior, input.running);
      if (decision.kind === "none") {
        return "none";
      }
      held = true;
      try {
        effects.clearInput();
        if (decision.kind === "queue") {
          effects.queueMessage({ text, images });
          return "queued";
        }
        await effects.sendMessage(text, {
          activeTurnBehavior: decision.activeTurnBehavior,
          ...imagesOption(images),
        });
        return "sent";
      } finally {
        held = false;
      }
    },
    async sendNow(input: {
      text: string;
      images: readonly ComposerImage[];
      activeTurnBehavior: ActiveTurnBehavior;
    }): Promise<"sent" | "none"> {
      if (held) {
        return "none";
      }
      held = true;
      try {
        await effects.sendMessage(input.text, {
          activeTurnBehavior: input.activeTurnBehavior,
          ...imagesOption(input.images),
        });
        return "sent";
      } finally {
        held = false;
      }
    },
  };
}
