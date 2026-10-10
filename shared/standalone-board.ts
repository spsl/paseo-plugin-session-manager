/** Pure logic for opening the board in its own desktop window (no DOM access). */

export const HANDOFF_KEY = "session-manager:open-board";
export const HANDOFF_MAX_AGE_MS = 15_000;
export const STANDALONE_PARAM = "standalone";

export interface Handoff {
  readonly at: number;
  readonly origin: string;
}

export type HandoffDecision = "consume" | "ignore" | "discard";

export function createHandoff(now: number, origin: string): string {
  return JSON.stringify({ at: now, origin });
}

export function parseHandoff(raw: string | null): Handoff | null {
  if (raw === null) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) {
      return null;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.at !== "number" || typeof record.origin !== "string") {
      return null;
    }
    return { at: record.at, origin: record.origin };
  } catch {
    return null;
  }
}

/**
 * consume: fresh flag written by another window; discard: stale/garbled flag
 * (remove it); ignore: no flag, or our own flag (leave it for the new window).
 */
export function decideHandoff(raw: string | null, now: number, ownOrigin: string): HandoffDecision {
  if (raw === null) {
    return "ignore";
  }
  const handoff = parseHandoff(raw);
  if (handoff === null) {
    return "discard";
  }
  if (now - handoff.at > HANDOFF_MAX_AGE_MS || handoff.at - now > HANDOFF_MAX_AGE_MS) {
    return "discard";
  }
  return handoff.origin === ownOrigin ? "ignore" : "consume";
}

/** Builds the board URL for the current host from the current page href. */
export function buildStandaloneBoardUrl(href: string): string | null {
  const marker = "/h/";
  const start = href.indexOf(marker);
  if (start < 0) {
    return null;
  }
  const rest = href.slice(start + marker.length);
  let end = 0;
  while (end < rest.length && rest[end] !== "/" && rest[end] !== "?" && rest[end] !== "#") {
    end += 1;
  }
  const serverId = rest.slice(0, end);
  if (serverId.length === 0) {
    return null;
  }
  return `paseo://app/h/${serverId}/plugin/session-manager/surface/board?param.${STANDALONE_PARAM}=1`;
}
