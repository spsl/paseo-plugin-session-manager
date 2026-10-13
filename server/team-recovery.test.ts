import { describe, expect, it } from "vitest";
import { newRecord } from "./lifecycle";
import type { SessionRecord } from "./store";
import { interruptedTeamGroups, teamRecoveryMessage } from "./team-recovery";

function member(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    ...newRecord({ id, provider: "claude", cwd: "/w" }, 1),
    liveness: "dormant",
    parentAgentId: "coord",
    interruptedAt: 1_000,
    labels: { team: "20261013-login", role: "designer-a" },
    labelsKnown: true,
    ...overrides,
  };
}

describe("interruptedTeamGroups", () => {
  it("groups interrupted, unreported team sub-agents by coordinator", () => {
    const groups = interruptedTeamGroups([
      member("b", { labels: { team: "20261013-login", role: "designer-b" } }),
      member("a"),
      member("other", { parentAgentId: "coord-2", labels: { team: "20261014-pay" } }),
    ]);
    expect(groups).toHaveLength(2);
    const first = groups.find((group) => group.coordinatorId === "coord");
    expect(first?.members.map((m) => [m.id, m.role])).toEqual([
      ["a", "designer-a"],
      ["b", "designer-b"],
    ]);
    expect(groups.find((group) => group.coordinatorId === "coord-2")?.members[0].role).toBeNull();
  });

  it("skips records that are not interrupted team sub-agents or were already reported", () => {
    expect(
      interruptedTeamGroups([
        member("no-team", { labels: { role: "x" } }),
        member("unknown-labels", { labelsKnown: false }),
        member("top-level", { parentAgentId: null }),
        member("not-interrupted", { interruptedAt: null }),
        member("reported", { interruptNotifiedAt: 1_000 }),
        member("closed", { liveness: "closed" }),
      ]),
    ).toEqual([]);
    // A later restart (new interruptedAt) is reported again.
    expect(interruptedTeamGroups([member("again", { interruptedAt: 2_000, interruptNotifiedAt: 1_000 })])).toHaveLength(1);
  });
});

describe("teamRecoveryMessage", () => {
  it("starts with the /dev-team command and lists every interrupted member", () => {
    const [group] = interruptedTeamGroups([
      member("a", { agentTitle: "[20261013-login] 方案A" }),
      member("p", { labels: { team: "20261014-pay", role: "implementer" } }),
    ]);
    const text = teamRecoveryMessage(group);
    const lines = text.split("\n");
    expect(lines[0]).toBe("/dev-team 继续 20261013-login");
    expect(text).toContain("- 需求 20261013-login：designer-a（agentId a，[20261013-login] 方案A）");
    expect(text).toContain("- 需求 20261014-pay：implementer（agentId p）");
    expect(text).toContain("另外 20261014-pay 也有子 Agent 被中断");
    expect(text).toContain("不代表任务完成或失败");
  });
});
