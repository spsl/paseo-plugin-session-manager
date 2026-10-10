/** Pure helpers deciding which agents (typically other plugins' helpers) the board ignores. */

export type AgentExclusion = { key: string; value: string | null };

const SEPARATOR = /[\s,，;；]+/;

/** Parses "key, key=value" text (comma or whitespace separated) into exclusion rules. */
export function parseExclusions(text: string | null | undefined): AgentExclusion[] {
  const rules: AgentExclusion[] = [];
  for (const part of (text ?? "").split(SEPARATOR)) {
    if (part === "") {
      continue;
    }
    const at = part.indexOf("=");
    if (at < 0) {
      rules.push({ key: part, value: null });
    } else if (at > 0) {
      rules.push({ key: part.slice(0, at), value: part.slice(at + 1) });
    }
  }
  return rules;
}

function matchesRule(labels: Readonly<Record<string, string>>, rule: AgentExclusion): boolean {
  if (!Object.prototype.hasOwnProperty.call(labels, rule.key)) {
    return false;
  }
  return rule.value === null || labels[rule.key] === rule.value;
}

/** True when any label key (or key=value pair) matches an exclusion rule exactly. */
export function isExcludedAgent(
  labels: Readonly<Record<string, string>> | null | undefined,
  exclusions: readonly AgentExclusion[],
): boolean {
  if (!labels || exclusions.length === 0) {
    return false;
  }
  return exclusions.some(function matches(rule) {
    return matchesRule(labels, rule);
  });
}
