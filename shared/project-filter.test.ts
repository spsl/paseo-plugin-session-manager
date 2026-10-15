import { describe, expect, it } from "vitest";
import {
  buildProjectFilter,
  buildProjectWorkspaces,
  filterSessionsByProject,
  filterSessionsByProjectSearch,
  retainAvailableProjectSelection,
  searchProjectOptions,
} from "./project-filter";
import { makeSession } from "./test-fixtures";

function session(id: string, projectKey: string | null, projectName: string | null, updatedAt: number) {
  return makeSession({ id, projectKey, projectName, updatedAt });
}

describe("project filter", () => {
  it("groups sessions by project key and uses the project name", () => {
    const filter = buildProjectFilter([
      session("one", "p-orca", "Orca", 1),
      session("two", "p-orca", "Orca", 2),
    ]);
    expect(filter.options).toEqual([{ key: "p-orca", label: "Orca", latestUpdatedAt: 2 }]);
    expect(filter.projectKeyBySessionId.get("one")).toBe("p-orca");
  });

  it("isolates sessions without a project as unknown", () => {
    const filter = buildProjectFilter([session("known", "p-a", "api", 1), session("x", null, null, 2)]);
    expect(filter.options).toEqual(
      expect.arrayContaining([
        { key: "p-a", label: "api", latestUpdatedAt: 1 },
        { key: "unknown", label: "未知项目", latestUpdatedAt: 2 },
      ]),
    );
  });

  it("adds the key only when names collide", () => {
    const filter = buildProjectFilter([session("a", "k-local", "orca", 1), session("b", "k-remote", "orca", 1)]);
    expect(filter.options.map(({ label }) => label)).toEqual(["orca · k-local", "orca · k-remote"]);
  });

  it("keeps closed-only projects selectable", () => {
    const sessions = [
      session("open", "p-a", "api", 1),
      makeSession({ id: "closed", projectKey: "p-a", projectName: "api", updatedAt: 2, column: "closed" }),
      makeSession({ id: "archived", projectKey: "p-b", projectName: "web", updatedAt: 3, column: "closed" }),
    ];
    const filter = buildProjectFilter(sessions);
    expect(filter.options.map(({ key }) => key)).toEqual(["p-a", "p-b"]);
    expect(filterSessionsByProject(sessions, filter.projectKeyBySessionId, new Set(["p-b"]))).toHaveLength(1);
  });

  it("sorts by minute bucket of activity then by name", () => {
    const minute = 60_000;
    const filter = buildProjectFilter([
      session("z", "kz", "Zulu", minute * 10 + 14_000),
      session("a", "ka", "Alpha", minute * 10 + 35_000),
      session("n", "kn", "New", minute * 11),
    ]);
    expect(filter.options.map(({ label }) => label)).toEqual(["New", "Alpha", "Zulu"]);
  });

  it("filters multiple projects and drops selections no longer present", () => {
    const sessions = [session("one", "k1", "One", 1), session("two", "k2", "Two", 2)];
    const filter = buildProjectFilter(sessions);
    const selected = new Set(["k1", "gone"]);
    expect(
      filterSessionsByProject(sessions, filter.projectKeyBySessionId, selected).map(({ id }) => id),
    ).toEqual(["one"]);
    expect(filterSessionsByProject(sessions, filter.projectKeyBySessionId, new Set())).toHaveLength(2);
    expect(retainAvailableProjectSelection(selected, filter.options)).toEqual(new Set(["k1"]));
  });

  it("searches chip labels by case-insensitive substring", () => {
    const filter = buildProjectFilter([
      session("a", "k1", "sunsai-1022-enterrequest", 3),
      session("b", "k2", "Sunsai-1022-FunctionCall", 2),
      session("c", "k3", "paseo-session-manager-plugin", 1),
    ]);
    expect(searchProjectOptions(filter.options, "  ")).toBeNull();
    expect(searchProjectOptions(filter.options, "1022")?.map(({ key }) => key)).toEqual(["k1", "k2"]);
    expect(searchProjectOptions(filter.options, "functioncall")?.map(({ key }) => key)).toEqual(["k2"]);
    expect(searchProjectOptions(filter.options, "1d2")).toEqual([]);
  });

  it("shows the sessions of every hit, narrowed by visible selected chips", () => {
    const sessions = [
      session("a", "k1", "sunsai-1022-a", 3),
      session("b", "k2", "sunsai-1022-b", 2),
      session("c", "k3", "plugin", 1),
    ];
    const filter = buildProjectFilter(sessions);
    const map = filter.projectKeyBySessionId;
    const ids = (selected: Set<string>, query: string) =>
      filterSessionsByProjectSearch(sessions, map, selected, searchProjectOptions(filter.options, query)).map(
        ({ id }) => id,
      );
    expect(ids(new Set(), "")).toEqual(["a", "b", "c"]);
    expect(ids(new Set(["k3"]), "")).toEqual(["c"]);
    expect(ids(new Set(), "1022")).toEqual(["a", "b"]);
    expect(ids(new Set(["k2"]), "1022")).toEqual(["b"]);
    // A selected chip the search hides does not blank the board.
    expect(ids(new Set(["k3"]), "1022")).toEqual(["a", "b"]);
    expect(ids(new Set(), "nothing")).toEqual([]);
  });

  it("lists each project's unarchived workspaces, most recent first", () => {
    const sessions = [
      makeSession({ id: "main", projectKey: "p", workspaceId: "w-main", workspaceName: "开发看板", branch: "main" }),
      makeSession({
        id: "main-2",
        projectKey: "p",
        workspaceId: "w-main",
        workspaceName: "开发看板",
        branch: "main",
        updatedAt: 5_000,
      }),
      makeSession({
        id: "tree",
        projectKey: "p",
        workspaceId: "w-tree",
        workspaceName: null,
        cwd: "/w/team-align",
        branch: "team/align",
        updatedAt: 3_000,
      }),
      makeSession({ id: "old", projectKey: "p", workspaceId: "w-old", updatedAt: 9_000, liveness: "archived" }),
      makeSession({ id: "dir", projectKey: "q", workspaceId: "w-dir", workspaceName: "下载", cwd: "/Users/ada/Downloads" }),
      makeSession({ id: "none", projectKey: "q", workspaceId: null, updatedAt: 4_000 }),
    ];
    const filter = buildProjectFilter(sessions);
    const workspaces = buildProjectWorkspaces(sessions, filter.projectKeyBySessionId);
    expect(workspaces.get("p")).toEqual([
      { workspaceId: "w-main", label: "开发看板", detail: "main", latestUpdatedAt: 5_000 },
      { workspaceId: "w-tree", label: "team-align", detail: "team/align", latestUpdatedAt: 3_000 },
    ]);
    expect(workspaces.get("q")).toEqual([
      { workspaceId: "w-dir", label: "下载", detail: "/Users/ada/Downloads", latestUpdatedAt: 1_000 },
    ]);
  });

  it("drops a project whose workspaces are all archived", () => {
    const sessions = [makeSession({ id: "gone", projectKey: "p", workspaceId: "w", liveness: "archived" })];
    const filter = buildProjectFilter(sessions);
    expect(buildProjectWorkspaces(sessions, filter.projectKeyBySessionId).has("p")).toBe(false);
  });
});
