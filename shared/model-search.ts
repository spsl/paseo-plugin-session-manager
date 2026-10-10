/**
 * Subsequence ("fuzzy") matching for long model catalogs: a query matches when
 * its characters appear in order, so `g6s` finds `group/openai-gpt-6.1-sol`.
 * Scoring prefers early hits, word-boundary hits and contiguous runs, which is
 * what makes the ordering feel right rather than merely filtered.
 *
 * Client-reachable (Hermes): no async arrows, no closures inside for...of.
 */

export type SearchEntry = { id: string; label: string; provider: string };

const SEPARATORS = new Set(["/", "-", "_", ".", " "]);

/**
 * Scores `query` against `text`; a higher score is a better match and a
 * negative score means no match. Case-insensitive.
 */
export function fuzzyScore(query: string, text: string): number {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return 0;
  }
  const haystack = text.toLowerCase();
  let score = 0;
  let cursor = 0;
  let previousMatch = -2;
  for (const character of needle) {
    const found = haystack.indexOf(character, cursor);
    if (found === -1) {
      return -1;
    }
    // Reward a hit that starts a segment (after a separator or at the start).
    if (found === 0 || SEPARATORS.has(haystack[found - 1] ?? "")) {
      score += 8;
    }
    // Reward adjacency, and punish long gaps between matched characters.
    if (found === previousMatch + 1) {
      score += 6;
    } else {
      score -= Math.min(found - previousMatch - 1, 6);
    }
    previousMatch = found;
    cursor = found + 1;
    score += 1;
  }
  // Prefer shorter haystacks, so an exact short id outranks a long one that
  // merely contains the query.
  return score - Math.floor(haystack.length / 24);
}

/** Filters and orders entries by how well they match, best first. */
export function searchEntries<T extends SearchEntry>(
  entries: readonly T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return [...entries];
  }
  const scored: { entry: T; score: number }[] = [];
  for (const entry of entries) {
    // The id carries the identity, the label the readable text; matching either
    // means searching for `gpt-6` or `gemini` both work.
    const best = Math.max(
      fuzzyScore(needle, entry.id),
      fuzzyScore(needle, entry.label),
      fuzzyScore(needle, entry.provider),
    );
    if (best >= 0) {
      scored.push({ entry, score: best });
    }
  }
  scored.sort(function compare(left, right) {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.entry.id.localeCompare(right.entry.id);
  });
  return scored.map(function unwrap(item) {
    return item.entry;
  });
}
