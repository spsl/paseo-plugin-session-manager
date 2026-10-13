/**
 * Restart recovery for /dev-team: a coordinator creates sub-agents labelled
 * `team=<ID>` and waits for Paseo's finish notifications. A Paseo restart
 * interrupts running sub-agents without any notification, so the coordinator
 * would wait forever. After a restart the service tells each coordinator
 * which of its team sub-agents were interrupted — a fact, not a verdict.
 */
import { isActiveLiveness } from "../shared/types";
import type { SessionRecord } from "./store";

/** Label a /dev-team coordinator puts on every sub-agent it creates. */
export const TEAM_LABEL = "team";
export const TEAM_ROLE_LABEL = "role";

export type InterruptedMember = {
  id: string;
  team: string;
  role: string | null;
  title: string | null;
  interruptedAt: number;
};

export type TeamRecoveryGroup = {
  coordinatorId: string;
  /** Sorted by team, then role. */
  members: InterruptedMember[];
};

/** Team sub-agents interrupted by a restart and not yet reported, grouped by coordinator. */
export function interruptedTeamGroups(records: Iterable<SessionRecord>): TeamRecoveryGroup[] {
  const groups = new Map<string, InterruptedMember[]>();
  for (const record of records) {
    const team = record.labelsKnown ? record.labels[TEAM_LABEL]?.trim() : undefined;
    if (
      !team ||
      !record.parentAgentId ||
      record.interruptedAt === null ||
      record.interruptNotifiedAt === record.interruptedAt ||
      !isActiveLiveness(record.liveness)
    ) {
      continue;
    }
    const members = groups.get(record.parentAgentId) ?? [];
    members.push({
      id: record.id,
      team,
      role: record.labels[TEAM_ROLE_LABEL]?.trim() || null,
      title: record.agentTitle,
      interruptedAt: record.interruptedAt,
    });
    groups.set(record.parentAgentId, members);
  }
  return [...groups.entries()].map(([coordinatorId, members]) => ({
    coordinatorId,
    members: members.sort(
      (left, right) =>
        left.team.localeCompare(right.team) || (left.role ?? "").localeCompare(right.role ?? ""),
    ),
  }));
}

function formatClock(at: number): string {
  return new Date(at).toLocaleString("zh-CN", { hour12: false });
}

/**
 * The message for one coordinator. It starts with the /dev-team command so a
 * coordinator that lost the skill to compaction reloads it.
 */
export function teamRecoveryMessage(group: TeamRecoveryGroup): string {
  const teams = [...new Set(group.members.map((member) => member.team))];
  const restartAt = Math.min(...group.members.map((member) => member.interruptedAt));
  const lines = group.members.map((member) => {
    const role = member.role ?? "未标角色";
    const title = member.title ? `，${member.title}` : "";
    return `- 需求 ${member.team}：${role}（agentId ${member.id}${title}）`;
  });
  const more =
    teams.length > 1 ? `另外 ${teams.slice(1).join("、")} 也有子 Agent 被中断，请逐个需求处理。` : null;
  return [
    `/dev-team 继续 ${teams[0]}`,
    `[看板插件] Paseo 在 ${formatClock(restartAt)} 左右重启，下面这些子 Agent 当时正在运行，已被中断：`,
    ...lines,
    ...(more ? [more] : []),
    "这是事实通知，不代表任务完成或失败。请按 /dev-team 的「恢复」处理，被中断的子 Agent 属于「中断」类。",
  ].join("\n");
}
