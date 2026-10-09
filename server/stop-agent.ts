/** Interrupts a running agent turn via `paseo stop <id> --home <PASEO_HOME> --json`. */
import { paseoHome } from "./data-dir";
import { findPaseoCli, spawnBounded } from "./cli";

const STOP_TIMEOUT_MS = 15_000;

export function isSafeAgentId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

export async function stopAgentViaCli(agentId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!isSafeAgentId(agentId)) {
    return { ok: false, reason: "无效的会话标识" };
  }
  const cli = await findPaseoCli();
  if (!cli) {
    return { ok: false, reason: "未找到 paseo 命令，无法停止" };
  }
  const result = await spawnBounded({
    program: cli,
    args: ["stop", agentId, "--home", paseoHome(), "--json"],
    env: process.env,
    timeoutMs: STOP_TIMEOUT_MS,
    outputLimit: 64 * 1024,
  });
  if (result.timedOut) {
    return { ok: false, reason: "停止超时" };
  }
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split("\n")[0]?.slice(0, 280);
    return { ok: false, reason: detail || `停止失败（code=${String(result.code)}）` };
  }
  return { ok: true };
}
