/**
 * Project filter keyed by Paseo projectKey/projectName. Ported from orcb
 * `session-observer-project-filter.ts`.
 */
import type { SessionView } from "./types";

export const UNKNOWN_PROJECT_KEY = "unknown";
export const UNKNOWN_PROJECT_LABEL = "未知项目";

export type ProjectFilterOption = {
  key: string;
  label: string;
  latestUpdatedAt: number;
};

export type ProjectFilter = {
  options: readonly ProjectFilterOption[];
  projectKeyBySessionId: ReadonlyMap<string, string>;
};

type ProjectAccumulator = {
  key: string;
  name: string | null;
  latestUpdatedAt: number;
};

function minuteBucket(timestamp: number): number {
  return Math.floor(timestamp / 60_000);
}

export function projectKeyOf(session: SessionView): string {
  const key = session.projectKey?.trim();
  return key ? key : UNKNOWN_PROJECT_KEY;
}

function compareOptions(left: ProjectFilterOption, right: ProjectFilterOption): number {
  const updatedAtDifference = minuteBucket(right.latestUpdatedAt) - minuteBucket(left.latestUpdatedAt);
  return (
    updatedAtDifference ||
    left.label.localeCompare(right.label, "zh-CN") ||
    left.key.localeCompare(right.key, "zh-CN")
  );
}

/**
 * Builds stable, client-local project filters from the latest full snapshot.
 * Every session contributes its project key, name and recency — even one that
 * embeds into a parent's card — so filtering still sees it.
 */
export function buildProjectFilter(sessions: readonly SessionView[]): ProjectFilter {
  const projectsByKey = new Map<string, ProjectAccumulator>();
  const projectKeyBySessionId = new Map<string, string>();

  for (const session of sessions) {
    const key = projectKeyOf(session);
    projectKeyBySessionId.set(session.id, key);
    const name = session.projectName?.trim() || null;
    const current = projectsByKey.get(key);
    if (current) {
      current.latestUpdatedAt = Math.max(current.latestUpdatedAt, session.updatedAt);
      current.name = current.name || name;
    } else {
      projectsByKey.set(key, { key, name, latestUpdatedAt: session.updatedAt });
    }
  }

  const options: ProjectFilterOption[] = [];
  for (const project of projectsByKey.values()) {
    options.push({
      key: project.key,
      label: project.key === UNKNOWN_PROJECT_KEY ? UNKNOWN_PROJECT_LABEL : project.name || UNKNOWN_PROJECT_LABEL,
      latestUpdatedAt: project.latestUpdatedAt,
    });
  }
  options.sort(compareOptions);

  // Disambiguate identical labels with the project key.
  const labelCounts = new Map<string, number>();
  for (const option of options) {
    labelCounts.set(option.label, (labelCounts.get(option.label) ?? 0) + 1);
  }
  const disambiguated: ProjectFilterOption[] = [];
  for (const option of options) {
    const collides = (labelCounts.get(option.label) ?? 0) > 1 && option.key !== UNKNOWN_PROJECT_KEY;
    disambiguated.push(collides ? { ...option, label: `${option.label} · ${option.key}` } : option);
  }
  disambiguated.sort(compareOptions);

  return { options: disambiguated, projectKeyBySessionId };
}

export function filterSessionsByProject(
  sessions: readonly SessionView[],
  projectKeyBySessionId: ReadonlyMap<string, string>,
  selectedProjectKeys: ReadonlySet<string>,
): readonly SessionView[] {
  if (selectedProjectKeys.size === 0) {
    return sessions;
  }
  return sessions.filter(function inSelection(session) {
    return selectedProjectKeys.has(projectKeyBySessionId.get(session.id) ?? UNKNOWN_PROJECT_KEY);
  });
}

/**
 * Case-insensitive substring search over chip labels. A blank query is no
 * search at all and returns null, so callers can tell it apart from no hits.
 */
export function searchProjectOptions(
  options: readonly ProjectFilterOption[],
  query: string,
): readonly ProjectFilterOption[] | null {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return null;
  }
  return options.filter(function hit(option) {
    return option.label.toLowerCase().includes(needle);
  });
}

/**
 * Sessions of the projects a search hit, narrowed further by the selected
 * chips the search still shows. A selected chip the search hides is ignored,
 * so the board falls back to every hit rather than going blank.
 */
export function filterSessionsByProjectSearch(
  sessions: readonly SessionView[],
  projectKeyBySessionId: ReadonlyMap<string, string>,
  selectedProjectKeys: ReadonlySet<string>,
  hits: readonly ProjectFilterOption[] | null,
): readonly SessionView[] {
  if (hits === null) {
    return filterSessionsByProject(sessions, projectKeyBySessionId, selectedProjectKeys);
  }
  const visibleSelection = retainAvailableProjectSelection(selectedProjectKeys, hits);
  const scope =
    visibleSelection.size > 0
      ? visibleSelection
      : new Set(
          hits.map(function keyOf(option) {
            return option.key;
          }),
        );
  return sessions.filter(function inScope(session) {
    return scope.has(projectKeyBySessionId.get(session.id) ?? UNKNOWN_PROJECT_KEY);
  });
}

export function retainAvailableProjectSelection(
  selectedProjectKeys: ReadonlySet<string>,
  options: readonly ProjectFilterOption[],
): Set<string> {
  const available = new Set<string>();
  for (const option of options) {
    available.add(option.key);
  }
  const retained = new Set<string>();
  for (const key of selectedProjectKeys) {
    if (available.has(key)) {
      retained.add(key);
    }
  }
  return retained;
}
