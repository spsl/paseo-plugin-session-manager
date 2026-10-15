import { describe, expect, it } from "vitest";
import {
  DEFAULT_LAUNCH_SETTINGS,
  effectiveSelection,
  initialChoice,
  launchConfig,
  launchProviders,
  moveSelection,
  preferredWorkspaceId,
  profileMatches,
  readProfiles,
  rememberLaunch,
  resolveChoice,
  searchWorkspaces,
  shortenPath,
  sortWorkspaces,
  toLaunchWorkspace,
  withModel,
  workspaceActivity,
  workspaceHeading,
  workspaceLabel,
  workspaceSubtitle,
  type LaunchProvider,
  type LaunchWorkspace,
  type WorkspaceDescriptorLike,
} from "./launch";

function descriptor(patch: Partial<WorkspaceDescriptorLike>): WorkspaceDescriptorLike {
  return {
    id: "wks_1",
    name: "main",
    title: null,
    projectDisplayName: "proj",
    projectRootPath: "/Users/sai/Developer/proj",
    workspaceDirectory: "/Users/sai/Developer/proj",
    workspaceKind: "local_checkout",
    activityAt: "2026-10-15T00:00:00.000Z",
    ...patch,
  };
}

function workspace(id: string, title: string, patch: Partial<LaunchWorkspace> = {}): LaunchWorkspace {
  return {
    id,
    title,
    projectName: title,
    branch: null,
    directory: `/Users/sai/Developer/${title}`,
    worktree: false,
    pinned: false,
    activityAt: 0,
    ...patch,
  };
}

const claude: LaunchProvider = {
  id: "claude",
  label: "Claude",
  models: [
    {
      id: "claude-opus-5-5",
      label: "Opus 5.5",
      isDefault: true,
      thinkingOptions: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium" },
        { id: "xhigh", label: "Extra High" },
      ],
      defaultThinkingOptionId: "medium",
    },
    {
      id: "claude-haiku-4-5",
      label: "Haiku 4.5",
    },
    {
      id: "claude-sonnet-5",
      label: "Sonnet 5",
      thinkingOptions: [
        { id: "off", label: "Off" },
        { id: "high", label: "High", isDefault: true },
      ],
    },
  ],
  modes: [
    { id: "plan", label: "Plan Mode" },
    { id: "default", label: "Always Ask" },
    { id: "auto", label: "Auto mode" },
  ],
  defaultModeId: "default",
};

const pi: LaunchProvider = { id: "pi", label: "Pi", models: null, modes: [], defaultModeId: null };

describe("toLaunchWorkspace", () => {
  it("prefers the title, then the name, and reads branch and activity", () => {
    const result = toLaunchWorkspace(
      descriptor({
        title: "开发看板插件",
        gitRuntime: { currentBranch: "main" },
        workspaceKind: "worktree",
        pinnedAt: "2026-10-01T00:00:00.000Z",
      }),
    );
    expect(result).toEqual({
      id: "wks_1",
      title: "开发看板插件",
      projectName: "proj",
      branch: "main",
      directory: "/Users/sai/Developer/proj",
      worktree: true,
      pinned: true,
      activityAt: Date.parse("2026-10-15T00:00:00.000Z"),
    });
    expect(toLaunchWorkspace(descriptor({ title: "  " }))?.title).toBe("main");
  });

  it("uses the custom project name and falls back to the project root", () => {
    const result = toLaunchWorkspace(
      descriptor({ projectCustomName: "看板", workspaceDirectory: undefined, activityAt: null }),
    );
    expect(result?.projectName).toBe("看板");
    expect(result?.directory).toBe("/Users/sai/Developer/proj");
    expect(result?.activityAt).toBe(0);
  });

  it("takes the board's recent activity when it is later than Paseo's", () => {
    expect(toLaunchWorkspace(descriptor({ activityAt: null }), 42)?.activityAt).toBe(42);
    expect(toLaunchWorkspace(descriptor({}), 42)?.activityAt).toBe(
      Date.parse("2026-10-15T00:00:00.000Z"),
    );
  });

  it("skips archiving workspaces and ones without a directory", () => {
    expect(toLaunchWorkspace(descriptor({ archivingAt: "2026-10-15T00:00:00.000Z" }))).toBeNull();
    expect(
      toLaunchWorkspace(descriptor({ workspaceDirectory: "", projectRootPath: "" })),
    ).toBeNull();
  });
});

describe("workspaceActivity", () => {
  it("keeps the latest update per workspace and skips sessions without one", () => {
    const activity = workspaceActivity([
      { workspaceId: "w1", updatedAt: 5 },
      { workspaceId: "w1", updatedAt: 9 },
      { workspaceId: " w2 ", updatedAt: 3 },
      { workspaceId: null, updatedAt: 100 },
      { workspaceId: "", updatedAt: 100 },
    ]);
    expect([...activity.entries()]).toEqual([
      ["w1", 9],
      ["w2", 3],
    ]);
  });
});

describe("sortWorkspaces", () => {
  it("puts pinned first, then most recent activity, then title", () => {
    const sorted = sortWorkspaces([
      workspace("a", "beta", { activityAt: 10 }),
      workspace("b", "alpha", { activityAt: 10 }),
      workspace("c", "old", { activityAt: 1, pinned: true }),
      workspace("d", "new", { activityAt: 99 }),
    ]);
    expect(sorted.map((entry) => entry.id)).toEqual(["c", "d", "b", "a"]);
  });
});

describe("workspace labels / shortenPath", () => {
  it("leads with the project and adds the title only when it differs", () => {
    const plugin = workspace("a", "开发看板插件", { projectName: "paseo-plugin", branch: "main" });
    expect(workspaceHeading(plugin)).toEqual({ main: "paseo-plugin", extra: "开发看板插件" });
    expect(workspaceLabel(plugin)).toBe("paseo-plugin / 开发看板插件");
    const tcm = workspace("b", "tcm");
    expect(workspaceHeading(tcm)).toEqual({ main: "tcm", extra: null });
    expect(workspaceLabel(tcm)).toBe("tcm");
    expect(workspaceHeading(workspace("c", "only", { projectName: "" })).main).toBe("only");
  });

  it("drops a branch that repeats the heading and shortens the home folder", () => {
    expect(workspaceSubtitle(workspace("a", "tcm", { projectName: "tcm", branch: "tcm" }))).toBe(
      "~/Developer/tcm",
    );
    expect(
      workspaceSubtitle(
        workspace("a", "开发看板插件", { projectName: "paseo-plugin", branch: "main" }),
      ),
    ).toBe("main · ~/Developer/开发看板插件");
    expect(shortenPath("/home/sai/x")).toBe("~/x");
    expect(shortenPath("/Users/sai")).toBe("~");
    expect(shortenPath("/opt/x")).toBe("/opt/x");
  });
});

describe("searchWorkspaces", () => {
  const list = [
    workspace("tcm", "sunsai-1119-tcm"),
    workspace("loghub", "sunsai-finance-1022-loghub"),
    workspace("plugin", "开发 Paseo 会话管理看板插件", {
      projectName: "paseo-session-manager-plugin",
      branch: "main",
      directory: "/Users/sai/Developer/paseo-session-manager-plugin",
    }),
    workspace("align", "20261013-composer-align", {
      projectName: "paseo-session-manager-plugin",
      branch: "team/20261013-composer-align",
      directory: "/Users/sai/.paseo/worktrees/15eh7sf1/team-20261013-composer-align",
      worktree: true,
    }),
  ];

  it("returns everything in order for a blank query", () => {
    expect(searchWorkspaces(list, "   ").map((entry) => entry.id)).toEqual([
      "tcm",
      "loghub",
      "plugin",
      "align",
    ]);
  });

  it("matches title, project and branch, best match first", () => {
    expect(searchWorkspaces(list, "tcm").map((entry) => entry.id)).toEqual(["tcm"]);
    expect(searchWorkspaces(list, "paseo").map((entry) => entry.id)).toEqual(["plugin", "align"]);
    expect(searchWorkspaces(list, "看板").map((entry) => entry.id)).toEqual(["plugin"]);
  });

  it("falls back to abbreviations only when nothing contains the text", () => {
    expect(searchWorkspaces(list, "smp").map((entry) => entry.id)).toEqual(["plugin", "align"]);
    expect(searchWorkspaces(list, "zzz")).toEqual([]);
  });

  it("requires every token to match", () => {
    expect(searchWorkspaces(list, "paseo align").map((entry) => entry.id)).toEqual(["align"]);
    expect(searchWorkspaces(list, "finance tcm")).toEqual([]);
  });

  it("matches the full path only as a substring", () => {
    expect(searchWorkspaces(list, "worktrees").map((entry) => entry.id)).toEqual(["align"]);
    expect(searchWorkspaces(list, "/users/sai/developer/sunsai-1119").map((entry) => entry.id)).toEqual([
      "tcm",
    ]);
  });
});

describe("effectiveSelection / moveSelection", () => {
  const hits = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("keeps a visible selection, else falls back to the first row", () => {
    expect(effectiveSelection(hits, "b")).toBe("b");
    expect(effectiveSelection(hits, "z")).toBe("a");
    expect(effectiveSelection(hits, null)).toBe("a");
    expect(effectiveSelection([], "a")).toBeNull();
  });

  it("moves and clamps", () => {
    expect(moveSelection(hits, "a", 1)).toBe("b");
    expect(moveSelection(hits, "c", 1)).toBe("c");
    expect(moveSelection(hits, "a", -1)).toBe("a");
    expect(moveSelection(hits, "z", 1)).toBe("b");
    expect(moveSelection([], "a", 1)).toBeNull();
  });
});

describe("launchProviders", () => {
  it("keeps enabled providers that are ready or loading, in order", () => {
    const providers = launchProviders([
      { provider: "claude", status: "ready", enabled: true, label: "Claude", models: [], modes: [] },
      { provider: "copilot", status: "unavailable", enabled: false },
      { provider: "droid", status: "error", enabled: true },
      { provider: "pi", status: "loading", enabled: true },
      { provider: "off", status: "ready", enabled: false },
    ]);
    expect(providers.map((entry) => entry.id)).toEqual(["claude", "pi"]);
    expect(providers[0]?.models).toBeNull();
    expect(providers[1]?.label).toBe("pi");
  });
});

describe("resolveChoice / withModel", () => {
  it("falls back to the default model, its default thinking and the default mode", () => {
    expect(resolveChoice(claude, undefined)).toEqual({
      provider: "claude",
      model: "claude-opus-5-5",
      thinkingOptionId: "medium",
      modeId: "default",
    });
  });

  it("keeps remembered values the catalog still offers", () => {
    expect(
      resolveChoice(claude, { model: "claude-opus-5-5", thinkingOptionId: "xhigh", modeId: "auto" }),
    ).toEqual({ provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "xhigh", modeId: "auto" });
  });

  it("replaces values the catalog no longer offers", () => {
    expect(
      resolveChoice(claude, { model: "gone", thinkingOptionId: "max", modeId: "bypass" }),
    ).toEqual({ provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "medium", modeId: "default" });
  });

  it("keeps remembered values while the catalog is still loading", () => {
    expect(resolveChoice(pi, { model: "gpt-x", thinkingOptionId: "high", modeId: "" })).toEqual({
      provider: "pi",
      model: "gpt-x",
      thinkingOptionId: "high",
      modeId: "",
    });
  });

  it("keeps thinking across a model switch only when the new model supports it", () => {
    const start = resolveChoice(claude, { thinkingOptionId: "low" });
    expect(withModel(claude, start, "claude-sonnet-5").thinkingOptionId).toBe("high");
    expect(withModel(claude, start, "claude-haiku-4-5").thinkingOptionId).toBe("");
    const high = { ...start, model: "claude-sonnet-5", thinkingOptionId: "high" };
    expect(withModel(claude, high, "claude-opus-5-5").thinkingOptionId).toBe("medium");
  });
});

describe("profiles", () => {
  const config = {
    agentProfiles: [
      {
        id: "p1",
        name: "技术方案设计",
        provider: "claude",
        model: "claude-opus-5-5",
        modeId: "auto",
        thinkingOptionId: "xhigh",
      },
      { id: "p2", name: "代码实施", provider: "devin", featureValues: { auto_accept: true } },
      { name: "no id", provider: "claude" },
      "junk",
    ],
  };

  it("reads profiles from the flat or the nested daemon config", () => {
    expect(readProfiles(config).map((profile) => profile.id)).toEqual(["p1", "p2"]);
    expect(readProfiles({ daemon: config }).map((profile) => profile.id)).toEqual(["p1", "p2"]);
    expect(readProfiles(null)).toEqual([]);
    expect(readProfiles({})).toEqual([]);
  });

  it("matches only while the choice carries every value the profile sets", () => {
    const [profile] = readProfiles(config);
    if (profile === undefined) {
      throw new Error("missing profile");
    }
    const choice = { provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "xhigh", modeId: "auto" };
    expect(profileMatches(profile, choice)).toBe(true);
    expect(profileMatches(profile, { ...choice, modeId: "plan" })).toBe(false);
  });

  it("passes feature values only for a matching profile", () => {
    const [, devin] = readProfiles(config);
    if (devin === undefined) {
      throw new Error("missing profile");
    }
    const choice = { provider: "devin", model: "swe", thinkingOptionId: "", modeId: "" };
    expect(launchConfig(choice, devin)).toEqual({
      provider: "devin/swe",
      featureValues: { auto_accept: true },
    });
    expect(launchConfig({ ...choice, provider: "claude" }, devin)).toEqual({ provider: "claude/swe" });
  });
});

describe("launchConfig", () => {
  it("joins provider and model and drops empty ids", () => {
    expect(
      launchConfig({ provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "xhigh", modeId: "auto" }, null),
    ).toEqual({ provider: "claude/claude-opus-5-5", thinkingOptionId: "xhigh", modeId: "auto" });
    expect(launchConfig({ provider: "pi", model: "", thinkingOptionId: "", modeId: "" }, null)).toEqual({
      provider: "pi",
    });
  });
});

describe("remembering", () => {
  it("records the workspace, provider, profile and per-provider values", () => {
    const first = rememberLaunch(
      DEFAULT_LAUNCH_SETTINGS,
      "wks_1",
      { provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "xhigh", modeId: "auto" },
      "p1",
    );
    const second = rememberLaunch(first, "wks_2", { provider: "pi", model: "m", thinkingOptionId: "", modeId: "" }, null);
    expect(second).toEqual({
      lastWorkspaceId: "wks_2",
      lastProvider: "pi",
      lastProfileId: "",
      byProvider: {
        claude: { model: "claude-opus-5-5", thinkingOptionId: "xhigh", modeId: "auto" },
        pi: { model: "m", thinkingOptionId: "", modeId: "" },
      },
    });
  });

  it("starts from the last provider and keeps the last profile while it matches", () => {
    const settings = rememberLaunch(
      DEFAULT_LAUNCH_SETTINGS,
      "wks_1",
      { provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "xhigh", modeId: "auto" },
      "p1",
    );
    const profiles = readProfiles({
      agentProfiles: [
        { id: "p1", name: "设计", provider: "claude", model: "claude-opus-5-5", modeId: "auto", thinkingOptionId: "xhigh" },
      ],
    });
    expect(initialChoice([pi, claude], profiles, settings)).toEqual({
      choice: { provider: "claude", model: "claude-opus-5-5", thinkingOptionId: "xhigh", modeId: "auto" },
      profileId: "p1",
    });
    const changed = { ...settings, byProvider: { claude: { model: "claude-opus-5-5", thinkingOptionId: "low", modeId: "auto" } } };
    expect(initialChoice([claude], profiles, changed).profileId).toBeNull();
    expect(initialChoice([pi, claude], profiles, DEFAULT_LAUNCH_SETTINGS).choice?.provider).toBe("pi");
    expect(initialChoice([], profiles, settings)).toEqual({ choice: null, profileId: null });
  });

  it("preselects the board's workspace filter, else the last workspace", () => {
    const settings = { ...DEFAULT_LAUNCH_SETTINGS, lastWorkspaceId: "wks_last" };
    expect(preferredWorkspaceId("ws:wks_board", settings)).toBe("wks_board");
    expect(preferredWorkspaceId("proj:abc", settings)).toBe("wks_last");
    expect(preferredWorkspaceId(null, DEFAULT_LAUNCH_SETTINGS)).toBeNull();
  });
});
