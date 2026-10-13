/**
 * Agent mode / thinking-option mutations through the Paseo CLI: the plugin SDK
 * exposes `availableModes` and `thinkingOptionId` read-only, so the composer
 * controls go through `paseo agent mode` / `paseo agent update --thinking`,
 * mirroring stop-agent.ts.
 */
import { paseoHome } from "./data-dir";
import { findPaseoCli, spawnBounded } from "./cli";
import { isSafeAgentId } from "./stop-agent";

const CLI_TIMEOUT_MS = 15_000;

/** Option ids are plain identifiers; the leading-char rule also rejects `-`. */
export function isSafeOptionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

export async function runPaseoAgentCli(
  args: string[],
  verb = "操作",
): Promise<{ ok: boolean; reason?: string }> {
  const cli = await findPaseoCli();
  if (!cli) {
    return { ok: false, reason: `未找到 paseo 命令，无法${verb}` };
  }
  const result = await spawnBounded({
    program: cli,
    args: [...args, "--home", paseoHome(), "--json"],
    env: process.env,
    timeoutMs: CLI_TIMEOUT_MS,
    outputLimit: 64 * 1024,
  });
  if (result.timedOut) {
    return { ok: false, reason: `${verb}超时` };
  }
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim())
      .split("\n")[0]
      ?.slice(0, 280);
    return { ok: false, reason: detail || `${verb}失败（code=${String(result.code)}）` };
  }
  return { ok: true };
}

export function agentModeArgs(agentId: string, modeId: string): string[] {
  return ["agent", "mode", agentId, modeId];
}

export function agentThinkingArgs(agentId: string, thinkingOptionId: string): string[] {
  return ["agent", "update", agentId, "--thinking", thinkingOptionId];
}

export async function setAgentModeViaCli(
  agentId: string,
  modeId: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!isSafeAgentId(agentId) || !isSafeOptionId(modeId)) {
    return { ok: false, reason: "无效的模式参数" };
  }
  return runPaseoAgentCli(agentModeArgs(agentId, modeId), "设置模式");
}

export async function setAgentThinkingViaCli(
  agentId: string,
  thinkingOptionId: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (!isSafeAgentId(agentId) || !isSafeOptionId(thinkingOptionId)) {
    return { ok: false, reason: "无效的思考档位参数" };
  }
  return runPaseoAgentCli(agentThinkingArgs(agentId, thinkingOptionId), "设置思考档位");
}
