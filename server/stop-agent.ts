/** Interrupts a running agent turn via `paseo stop <id> --home <PASEO_HOME> --json`. */
import { runPaseoAgentCli } from "./agent-cli";

export function isSafeAgentId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

export async function stopAgentViaCli(agentId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!isSafeAgentId(agentId)) {
    return { ok: false, reason: "无效的会话标识" };
  }
  return runPaseoAgentCli(["stop", agentId], "停止");
}
