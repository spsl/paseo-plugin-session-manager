/** Deciding when the generated title may be written back to the Paseo agent. */
import { paseoHome } from "./data-dir";
import { findPaseoCli, spawnBounded } from "./cli";
import type { TitleState } from "../shared/types";

export type TitleDecision = "skip" | "write" | "mark_user_owned";

const WRITE_TIMEOUT_MS = 15_000;

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Empty, our last write, or a truncated prefix of the first prompt. */
export function isAutoTitle(
  currentTitle: string | null,
  titleState: Pick<TitleState, "lastWritten">,
  firstUserMessage: string | null,
): boolean {
  const current = collapse(currentTitle ?? "");
  if (current === "") {
    return true;
  }
  if (titleState.lastWritten !== null && current === collapse(titleState.lastWritten)) {
    return true;
  }
  if (firstUserMessage) {
    const stripped = current.replace(/(?:…|\.{3})$/, "").trim();
    if (stripped !== "" && collapse(firstUserMessage).startsWith(stripped)) {
      return true;
    }
  }
  return false;
}

export function decideTitleWrite(input: {
  enabled: boolean;
  live: boolean;
  userOwned: boolean;
  currentTitle: string | null;
  generatedTitle: string;
  titleState: Pick<TitleState, "lastWritten">;
  firstUserMessage: string | null;
}): TitleDecision {
  if (!input.enabled || !input.live || input.userOwned) {
    return "skip";
  }
  if (collapse(input.currentTitle ?? "") === collapse(input.generatedTitle)) {
    return "skip";
  }
  if (!isAutoTitle(input.currentTitle, input.titleState, input.firstUserMessage)) {
    return "mark_user_owned";
  }
  return "write";
}

/** `paseo agent update <id> --name <title> --home <PASEO_HOME> --json`; throws on failure. */
export async function writeTitleViaCli(agentId: string, title: string): Promise<void> {
  const cli = await findPaseoCli();
  if (!cli) {
    throw new Error("未找到 paseo 命令，无法回写标题");
  }
  const result = await spawnBounded({
    program: cli,
    args: ["agent", "update", agentId, "--name", title, "--home", paseoHome(), "--json"],
    env: process.env,
    timeoutMs: WRITE_TIMEOUT_MS,
    outputLimit: 64 * 1024,
  });
  if (result.timedOut) {
    throw new Error("回写标题超时");
  }
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split("\n")[0]?.slice(0, 280);
    throw new Error(detail || `回写标题失败（code=${String(result.code)}）`);
  }
}
