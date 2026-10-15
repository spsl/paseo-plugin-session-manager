/**
 * New-session launcher: workspace search plus the provider / model / thinking /
 * mode a new session starts from. The board's 新建会话 dialog feeds this
 * Paseo's workspace list, provider snapshot and agent profiles.
 *
 * Client-reachable (Hermes): no async arrows, no closures inside for...of.
 */
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { fuzzyScore } from "./model-search";

const ProviderMemorySchema = z.object({
  model: z.string().default(""),
  thinkingOptionId: z.string().default(""),
  modeId: z.string().default(""),
});

/** What the last launch used, so the next one starts there. */
export const LAUNCH_SETTINGS = defineSettings({
  id: "launch",
  scope: "host",
  version: 1,
  schema: z.object({
    lastWorkspaceId: z.string().default(""),
    lastProvider: z.string().default(""),
    /** Empty when the last launch was not from a profile. */
    lastProfileId: z.string().default(""),
    /** Per provider, the model / thinking / mode it was last launched with. */
    byProvider: z.record(z.string(), ProviderMemorySchema).default({}),
  }),
});

export type LaunchSettings = z.infer<typeof LAUNCH_SETTINGS.schema>;
export type ProviderMemory = z.infer<typeof ProviderMemorySchema>;

export const DEFAULT_LAUNCH_SETTINGS: LaunchSettings = {
  lastWorkspaceId: "",
  lastProvider: "",
  lastProfileId: "",
  byProvider: {},
};

// ---------------------------------------------------------------------------
// Workspaces

/** The fields of Paseo's workspace descriptor the launcher reads. */
export type WorkspaceDescriptorLike = {
  id: string;
  name: string;
  title?: string | null;
  projectDisplayName: string;
  projectCustomName?: string | null;
  projectRootPath: string;
  workspaceDirectory?: string;
  workspaceKind: string;
  pinnedAt?: string | null;
  archivingAt?: string | null;
  activityAt: string | null;
  gitRuntime?: { currentBranch?: string | null } | null;
};

export type LaunchWorkspace = {
  id: string;
  title: string;
  projectName: string;
  branch: string | null;
  directory: string;
  worktree: boolean;
  pinned: boolean;
  /** Epoch ms; 0 when Paseo has none. */
  activityAt: number;
};

function trimmed(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Latest session update per workspace, from the board's sessions. Paseo's own
 * workspace `activityAt` is often null, so this is what "recent" means here.
 */
export function workspaceActivity(
  sessions: readonly { workspaceId: string | null; updatedAt: number }[],
): Map<string, number> {
  const latest = new Map<string, number>();
  for (const session of sessions) {
    const id = session.workspaceId?.trim();
    if (id) {
      latest.set(id, Math.max(latest.get(id) ?? 0, session.updatedAt));
    }
  }
  return latest;
}

/**
 * null for a workspace being archived or without a directory to start in.
 * `recentActivity` (epoch ms, e.g. from `workspaceActivity`) counts when it is
 * later than Paseo's own `activityAt`.
 */
export function toLaunchWorkspace(
  descriptor: WorkspaceDescriptorLike,
  recentActivity = 0,
): LaunchWorkspace | null {
  if (trimmed(descriptor.archivingAt) !== "") {
    return null;
  }
  const directory = trimmed(descriptor.workspaceDirectory) || trimmed(descriptor.projectRootPath);
  if (directory === "") {
    return null;
  }
  const activity = descriptor.activityAt === null ? Number.NaN : Date.parse(descriptor.activityAt);
  return {
    id: descriptor.id,
    title: trimmed(descriptor.title) || trimmed(descriptor.name) || basename(directory),
    projectName: trimmed(descriptor.projectCustomName) || trimmed(descriptor.projectDisplayName),
    branch: trimmed(descriptor.gitRuntime?.currentBranch) || null,
    directory,
    worktree: descriptor.workspaceKind === "worktree",
    pinned: trimmed(descriptor.pinnedAt) !== "",
    activityAt: Math.max(Number.isFinite(activity) ? activity : 0, recentActivity),
  };
}

/** Pinned first, then most recently active, then by title. */
export function sortWorkspaces(workspaces: readonly LaunchWorkspace[]): LaunchWorkspace[] {
  return [...workspaces].sort(function compare(left, right) {
    if (left.pinned !== right.pinned) {
      return left.pinned ? -1 : 1;
    }
    return right.activityAt - left.activityAt || left.title.localeCompare(right.title, "zh-CN");
  });
}

export function basename(path: string): string {
  const parts = path.split("/").filter(function nonEmpty(part) {
    return part !== "";
  });
  return parts[parts.length - 1] ?? path;
}

/** `/Users/name/x` and `/home/name/x` shown as `~/x`. */
export function shortenPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/**
 * A row's first line. The project (folder) name leads: Paseo's workspace
 * title is often the first agent's title ("Greet and check in"), so it only
 * follows as `extra` when it says something else.
 */
export function workspaceHeading(workspace: LaunchWorkspace): { main: string; extra: string | null } {
  const main = workspace.projectName || workspace.title;
  return { main, extra: workspace.title !== main ? workspace.title : null };
}

/** A row's muted second line: branch and path, without repeating the heading. */
export function workspaceSubtitle(workspace: LaunchWorkspace): string {
  const heading = workspaceHeading(workspace);
  const parts: string[] = [];
  if (workspace.branch !== null && workspace.branch !== heading.main && workspace.branch !== heading.extra) {
    parts.push(workspace.branch);
  }
  parts.push(shortenPath(workspace.directory));
  return parts.join(" · ");
}

/** One line naming the workspace, e.g. for "在「…」中创建". */
export function workspaceLabel(workspace: LaunchWorkspace): string {
  const heading = workspaceHeading(workspace);
  return heading.extra === null ? heading.main : `${heading.main} / ${heading.extra}`;
}

/**
 * How well one token matches; negative is no match. `strict` accepts only
 * fields containing the token, the fallback any in-order subsequence. The
 * full path always matches as a substring only: as a subsequence almost any
 * short query would hit `/Users/...`.
 */
function tokenScore(token: string, workspace: LaunchWorkspace, strict: boolean): number {
  const fields = [
    workspace.title,
    workspace.projectName,
    workspace.branch ?? "",
    basename(workspace.directory),
  ];
  let best = -1;
  for (const field of fields) {
    const score = fuzzyScore(token, field);
    if (!strict) {
      best = Math.max(best, score);
    } else if (field.toLowerCase().includes(token)) {
      // The greedy subsequence can score a real substring poorly; it still counts.
      best = Math.max(best, Math.max(0, score) + 1);
    }
  }
  if (best >= 0) {
    return best;
  }
  return workspace.directory.toLowerCase().includes(token) ? 0 : -1;
}

function rank(
  workspaces: readonly LaunchWorkspace[],
  tokens: readonly string[],
  strict: boolean,
): LaunchWorkspace[] {
  const scored: { workspace: LaunchWorkspace; score: number; index: number }[] = [];
  workspaces.forEach(function score(workspace, index) {
    let total = 0;
    for (const token of tokens) {
      const value = tokenScore(token, workspace, strict);
      if (value < 0) {
        return;
      }
      total += value;
    }
    scored.push({ workspace, score: total, index });
  });
  scored.sort(function compare(left, right) {
    return right.score - left.score || left.index - right.index;
  });
  return scored.map(function unwrap(item) {
    return item.workspace;
  });
}

/**
 * Space-separated tokens must all match the title, project, branch, folder
 * name or full path. Rows containing the text win outright; only when none
 * does, abbreviations (`smp` → session-manager-plugin) match as in-order
 * subsequences. Better matches first; a tie keeps the incoming order, so
 * recent activity breaks it.
 */
export function searchWorkspaces(
  workspaces: readonly LaunchWorkspace[],
  query: string,
): LaunchWorkspace[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(function nonEmpty(token) {
      return token !== "";
    });
  if (tokens.length === 0) {
    return [...workspaces];
  }
  const exact = rank(workspaces, tokens, true);
  return exact.length > 0 ? exact : rank(workspaces, tokens, false);
}

/** The selected id when the list still shows it, else the first row. */
export function effectiveSelection(
  hits: readonly { id: string }[],
  selectedId: string | null,
): string | null {
  if (
    selectedId !== null &&
    hits.some(function match(hit) {
      return hit.id === selectedId;
    })
  ) {
    return selectedId;
  }
  return hits[0]?.id ?? null;
}

/** Arrow-key move inside the list, clamped at both ends. */
export function moveSelection(
  hits: readonly { id: string }[],
  selectedId: string | null,
  delta: number,
): string | null {
  if (hits.length === 0) {
    return null;
  }
  const current = hits.findIndex(function match(hit) {
    return hit.id === selectedId;
  });
  const from = current === -1 ? 0 : current;
  const next = Math.max(0, Math.min(hits.length - 1, from + delta));
  return hits[next]?.id ?? null;
}

// ---------------------------------------------------------------------------
// Providers, models, thinking, modes

export type LaunchOption = {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
};

export type LaunchModel = LaunchOption & {
  isSelectable?: boolean;
  thinkingOptions?: readonly LaunchOption[];
  defaultThinkingOptionId?: string;
};

export type LaunchMode = LaunchOption & { icon?: string; colorTier?: string };

export type LaunchProvider = {
  id: string;
  label: string;
  /** null while Paseo is still loading the catalog. */
  models: readonly LaunchModel[] | null;
  modes: readonly LaunchMode[];
  defaultModeId: string | null;
};

/** The fields of Paseo's provider snapshot entry the launcher reads. */
export type ProviderEntryLike = {
  provider: string;
  status: string;
  enabled?: boolean;
  label?: string;
  models?: readonly LaunchModel[];
  modes?: readonly LaunchMode[];
  defaultModeId?: string | null;
};

/** Enabled providers that are ready or still loading, in Paseo's order. */
export function launchProviders(entries: readonly ProviderEntryLike[]): LaunchProvider[] {
  const providers: LaunchProvider[] = [];
  for (const entry of entries) {
    if (entry.enabled === false || (entry.status !== "ready" && entry.status !== "loading")) {
      continue;
    }
    providers.push({
      id: entry.provider,
      label: trimmed(entry.label) || entry.provider,
      models: entry.models === undefined || entry.models.length === 0 ? null : entry.models,
      modes: entry.modes ?? [],
      defaultModeId: entry.defaultModeId ?? null,
    });
  }
  return providers;
}

/** Empty strings mean "the provider's default". */
export type LaunchChoice = {
  provider: string;
  model: string;
  thinkingOptionId: string;
  modeId: string;
};

function selectableModels(models: readonly LaunchModel[]): LaunchModel[] {
  return models.filter(function selectable(model) {
    return model.isSelectable !== false;
  });
}

export function findModel(
  provider: LaunchProvider,
  modelId: string,
): LaunchModel | null {
  return (
    provider.models?.find(function match(model) {
      return model.id === modelId;
    }) ?? null
  );
}

export function defaultModelId(models: readonly LaunchModel[]): string {
  const selectable = selectableModels(models);
  const preferred =
    selectable.find(function isDefault(model) {
      return model.isDefault === true;
    }) ?? selectable[0];
  return preferred?.id ?? "";
}

/** `wanted` when the catalog offers it (or is not loaded yet), else the default. */
export function pickModel(provider: LaunchProvider, wanted: string): string {
  if (provider.models === null) {
    return wanted;
  }
  if (wanted !== "" && findModel(provider, wanted) !== null) {
    return wanted;
  }
  return defaultModelId(provider.models);
}

export function defaultThinkingId(model: LaunchModel | null): string {
  const options = model?.thinkingOptions ?? [];
  if (options.length === 0) {
    return "";
  }
  const declared = model?.defaultThinkingOptionId ?? "";
  if (
    declared !== "" &&
    options.some(function match(option) {
      return option.id === declared;
    })
  ) {
    return declared;
  }
  const flagged = options.find(function isDefault(option) {
    return option.isDefault === true;
  });
  return flagged?.id ?? "";
}

/** `wanted` when the model offers it, else the model's default thinking. */
export function pickThinking(model: LaunchModel | null, wanted: string): string {
  const options = model?.thinkingOptions ?? [];
  if (
    wanted !== "" &&
    options.some(function match(option) {
      return option.id === wanted;
    })
  ) {
    return wanted;
  }
  return defaultThinkingId(model);
}

/** `wanted` when the provider offers it, else its default (or first) mode. */
export function pickMode(provider: LaunchProvider, wanted: string): string {
  const has = function has(id: string): boolean {
    return provider.modes.some(function match(mode) {
      return mode.id === id;
    });
  };
  if (wanted !== "" && has(wanted)) {
    return wanted;
  }
  if (provider.defaultModeId !== null && has(provider.defaultModeId)) {
    return provider.defaultModeId;
  }
  return provider.modes[0]?.id ?? "";
}

/** Fills a provider's model / thinking / mode from what was wanted, falling back to defaults. */
export function resolveChoice(
  provider: LaunchProvider,
  wanted: Partial<ProviderMemory> | undefined,
): LaunchChoice {
  const model = pickModel(provider, wanted?.model ?? "");
  const definition = findModel(provider, model);
  return {
    provider: provider.id,
    model,
    // An unloaded catalog keeps the remembered thinking as is.
    thinkingOptionId:
      provider.models === null
        ? (wanted?.thinkingOptionId ?? "")
        : pickThinking(definition, wanted?.thinkingOptionId ?? ""),
    modeId: pickMode(provider, wanted?.modeId ?? ""),
  };
}

/** A new model keeps the current thinking when it supports it. */
export function withModel(provider: LaunchProvider, choice: LaunchChoice, model: string): LaunchChoice {
  return {
    ...choice,
    model,
    thinkingOptionId: pickThinking(findModel(provider, model), choice.thinkingOptionId),
  };
}

// ---------------------------------------------------------------------------
// Paseo agent profiles

export type LaunchProfile = {
  id: string;
  name: string;
  provider: string;
  model: string;
  modeId: string;
  thinkingOptionId: string;
  featureValues: Record<string, unknown> | null;
};

function readProfile(value: unknown): LaunchProfile | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const text = function text(key: string): string {
    const field = raw[key];
    return typeof field === "string" ? field.trim() : "";
  };
  const id = text("id");
  const provider = text("provider");
  if (id === "" || provider === "") {
    return null;
  }
  const features = raw.featureValues;
  return {
    id,
    name: text("name") || id,
    provider,
    model: text("model"),
    modeId: text("modeId"),
    thinkingOptionId: text("thinkingOptionId"),
    featureValues:
      features !== null && typeof features === "object" && !Array.isArray(features)
        ? (features as Record<string, unknown>)
        : null,
  };
}

/** Profiles from Paseo's daemon config (`agentProfiles`); malformed rows are skipped. */
export function readProfiles(config: unknown): LaunchProfile[] {
  if (config === null || typeof config !== "object") {
    return [];
  }
  const record = config as Record<string, unknown>;
  const nested = record.daemon as Record<string, unknown> | undefined;
  const list = Array.isArray(record.agentProfiles)
    ? record.agentProfiles
    : Array.isArray(nested?.agentProfiles)
      ? nested.agentProfiles
      : [];
  const profiles: LaunchProfile[] = [];
  for (const value of list) {
    const profile = readProfile(value);
    if (profile !== null) {
      profiles.push(profile);
    }
  }
  return profiles;
}

export function choiceFromProfile(profile: LaunchProfile, provider: LaunchProvider): LaunchChoice {
  return resolveChoice(provider, {
    model: profile.model,
    thinkingOptionId: profile.thinkingOptionId,
    modeId: profile.modeId,
  });
}

/** Whether a choice still carries everything the profile sets. */
export function profileMatches(profile: LaunchProfile, choice: LaunchChoice): boolean {
  return (
    profile.provider === choice.provider &&
    (profile.model === "" || profile.model === choice.model) &&
    (profile.thinkingOptionId === "" || profile.thinkingOptionId === choice.thinkingOptionId) &&
    (profile.modeId === "" || profile.modeId === choice.modeId)
  );
}

// ---------------------------------------------------------------------------
// Creating and remembering

export type LaunchConfig = {
  /** `provider/model`, or just the provider for its default model. */
  provider: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
};

export function launchConfig(choice: LaunchChoice, profile: LaunchProfile | null): LaunchConfig {
  const config: LaunchConfig = {
    provider: choice.model === "" ? choice.provider : `${choice.provider}/${choice.model}`,
  };
  if (choice.modeId !== "") {
    config.modeId = choice.modeId;
  }
  if (choice.thinkingOptionId !== "") {
    config.thinkingOptionId = choice.thinkingOptionId;
  }
  if (profile !== null && profile.featureValues !== null && profileMatches(profile, choice)) {
    config.featureValues = profile.featureValues;
  }
  return config;
}

export function rememberLaunch(
  settings: LaunchSettings,
  workspaceId: string,
  choice: LaunchChoice,
  profileId: string | null,
): LaunchSettings {
  return {
    ...settings,
    lastWorkspaceId: workspaceId,
    lastProvider: choice.provider,
    lastProfileId: profileId ?? "",
    byProvider: {
      ...settings.byProvider,
      [choice.provider]: {
        model: choice.model,
        thinkingOptionId: choice.thinkingOptionId,
        modeId: choice.modeId,
      },
    },
  };
}

/**
 * Where a fresh dialog starts: the last provider (else the first) with what
 * it was last launched with, and the last profile while it still matches.
 */
export function initialChoice(
  providers: readonly LaunchProvider[],
  profiles: readonly LaunchProfile[],
  settings: LaunchSettings,
): { choice: LaunchChoice | null; profileId: string | null } {
  const provider =
    providers.find(function last(entry) {
      return entry.id === settings.lastProvider;
    }) ?? providers[0];
  if (provider === undefined) {
    return { choice: null, profileId: null };
  }
  const choice = resolveChoice(provider, settings.byProvider[provider.id]);
  const profile =
    profiles.find(function last(entry) {
      return entry.id === settings.lastProfileId;
    }) ?? null;
  return {
    choice,
    profileId: profile !== null && profileMatches(profile, choice) ? profile.id : null,
  };
}

/** The workspace a fresh dialog preselects: the board's filter, else the last one used. */
export function preferredWorkspaceId(
  boardWorkspaceKey: string | null,
  settings: LaunchSettings,
): string | null {
  if (boardWorkspaceKey !== null && boardWorkspaceKey.startsWith("ws:")) {
    return boardWorkspaceKey.slice(3);
  }
  return settings.lastWorkspaceId === "" ? null : settings.lastWorkspaceId;
}
