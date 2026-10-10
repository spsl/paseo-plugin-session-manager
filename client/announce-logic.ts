/** Pure helpers for the announcer's polling (no platform imports; unit-tested). */
import type { Announcement } from "../shared/speech";

export const POLL_MS = 2_500;
export const MAX_BACKOFF_MS = 30_000;

/** Poll delay after `failures` consecutive errors: 2.5s, then doubling up to 30s. */
export function nextDelay(failures: number): number {
  if (failures <= 0) {
    return POLL_MS;
  }
  return Math.min(MAX_BACKOFF_MS, POLL_MS * Math.pow(2, failures));
}

export type FreshResult = {
  /** Events to speak, oldest first. */
  fresh: Announcement[];
  /** Cursor to send on the next poll. */
  since: number;
};

/**
 * First poll only seeds the cursor: whatever was in the feed before this client
 * started is not news. Afterwards every event not seen yet is fresh.
 */
export function pickFresh(
  events: readonly Announcement[],
  cursor: number,
  previousSince: number,
  seen: Set<number>,
  seeding: boolean,
): FreshResult {
  const since = Math.max(previousSince, cursor);
  if (seeding) {
    for (const event of events) {
      seen.add(event.id);
    }
    return { fresh: [], since };
  }
  const fresh: Announcement[] = [];
  for (const event of events) {
    if (seen.has(event.id)) {
      continue;
    }
    seen.add(event.id);
    fresh.push(event);
  }
  fresh.sort(function byId(a, b) {
    return a.id - b.id;
  });
  // Bound the memory: ids are monotonic, so only recent ones can reappear.
  if (seen.size > 500) {
    const keep = [...seen].sort(function asc(a, b) {
      return a - b;
    });
    for (const id of keep.slice(0, keep.length - 200)) {
      seen.delete(id);
    }
  }
  return { fresh, since };
}
