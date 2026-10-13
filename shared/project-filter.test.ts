import { describe, expect, it } from "vitest";
import {
  buildProjectFilter,
  filterSessionsByProject,
  retainAvailableProjectSelection,
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
});
