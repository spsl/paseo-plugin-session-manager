/** Process helpers: locating CLIs and running bounded child processes. */
import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { AnalyzerAgent } from "../shared/analysis-config";

const EXTRA_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];
const LOGIN_SHELL_TIMEOUT_MS = 5_000;

export type SpawnResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

export type SpawnOptions = {
  program: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  outputLimit: number;
};

function killGroup(pid: number | undefined): void {
  if (pid === undefined) {
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

/** Runs a child in its own process group; never rejects on non-zero exit or spawn failure. */
export function spawnBounded(options: SpawnOptions): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      resolve({ code, stdout, stderr, timedOut, truncated });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(options.program, options.args, {
        cwd: options.cwd,
        env: options.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      stderr = error instanceof Error ? error.message : String(error);
      resolve({ code: null, stdout, stderr, timedOut: false, truncated: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
      graceTimer = setTimeout(() => finish(null), 2_000);
      graceTimer.unref?.();
    }, options.timeoutMs);
    timer.unref?.();
    const append = (current: string, chunk: string): string => {
      if (current.length + chunk.length > options.outputLimit) {
        truncated = true;
        return (current + chunk).slice(0, options.outputLimit);
      }
      return current + chunk;
    };
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      stderr = stderr || error.message;
      finish(null);
    });
    child.on("close", (code) => finish(code));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(options.input ?? "");
  });
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `git rev-parse HEAD` of a workspace; null on non-git directories or any failure. */
export async function gitHeadOf(cwd: string): Promise<string | null> {
  const trimmed = cwd.trim();
  if (trimmed === "") {
    return null;
  }
  const result = await spawnBounded({
    program: "git",
    args: ["-C", trimmed, "rev-parse", "HEAD"],
    timeoutMs: 5_000,
    outputLimit: 4 * 1024,
  });
  if (result.code !== 0 || result.timedOut) {
    return null;
  }
  const head = result.stdout.trim();
  return /^[0-9a-f]{7,40}$/.test(head) ? head : null;
}

/** The CLI the daemon shipped with (`PASEO_CLI`), then PATH and usual install dirs. */
export async function findPaseoCli(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const onPath = (env.PATH ?? "").split(delimiter).filter((dir) => dir !== "");
  const shipped = env.PASEO_CLI?.trim();
  const candidates = [
    ...(shipped ? [shipped] : []),
    ...[...onPath, join(homedir(), ".local", "bin"), ...EXTRA_DIRS].map((dir) => join(dir, "paseo")),
  ];
  for (const candidate of candidates) {
    if (await executable(candidate)) {
      return candidate;
    }
  }
  return null;
}

let loginPath: Promise<string> | null = null;

/** PATH of the user's interactive login shell (cached); empty when unavailable. */
export function loginShellPath(): Promise<string> {
  loginPath ??= (async () => {
    const shell = process.env.SHELL?.trim() || "/bin/zsh";
    const result = await spawnBounded({
      program: shell,
      args: ["-ilc", 'printf %s "$PATH"'],
      timeoutMs: LOGIN_SHELL_TIMEOUT_MS,
      outputLimit: 64 * 1024,
      env: process.env,
    });
    if (result.code !== 0 || result.timedOut) {
      return "";
    }
    return result.stdout.split("\n").at(-1)?.trim() ?? "";
  })();
  return loginPath;
}

/** Splits a command override with POSIX-style quotes and backslash escapes. */
export function tokenizeCommand(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      } else if (character === "\\" && quote === '"' && index + 1 < value.length) {
        index += 1;
        current += value[index];
      } else {
        current += character;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (character === "\\" && index + 1 < value.length) {
      index += 1;
      current += value[index];
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
    } else {
      current += character;
      started = true;
    }
  }
  if (quote) {
    throw new Error("Invalid command override: unterminated quote");
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

export function missingBinaryMessage(agent: AnalyzerAgent): string {
  return `未找到 ${agent} 命令，请在设置中填写可执行文件路径`;
}

export type ResolvedCommand = { program: string; prefixArgs: string[] };

/** Resolves the analyzer executable (override first, then PATH and common dirs). */
export async function resolveAnalyzerBinary(
  agent: AnalyzerAgent,
  commandOverride?: string,
): Promise<ResolvedCommand> {
  const tokens = commandOverride?.trim() ? tokenizeCommand(commandOverride.trim()) : [agent];
  const [name, ...prefixArgs] = tokens.length > 0 ? tokens : [agent];
  const expanded = name.startsWith("~/") ? join(homedir(), name.slice(2)) : name;
  if (isAbsolute(expanded) || expanded.includes("/")) {
    if (await executable(expanded)) {
      return { program: expanded, prefixArgs };
    }
    throw new Error(missingBinaryMessage(agent));
  }
  const directories = [
    ...(process.env.PATH ?? "").split(delimiter),
    ...(await loginShellPath()).split(delimiter),
    join(homedir(), ".local", "bin"),
    ...EXTRA_DIRS,
  ].filter((dir) => dir !== "");
  for (const directory of new Set(directories)) {
    const candidate = join(directory, expanded);
    if (await executable(candidate)) {
      return { program: candidate, prefixArgs };
    }
  }
  throw new Error(missingBinaryMessage(agent));
}

/** Environment for analyzer children: no Paseo/Claude markers, merged PATH. */
export async function buildAnalyzerEnv(binary: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PASEO_")) {
      delete env[key];
    }
  }
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  env.PASEO_SESSION_MANAGER_ANALYZER = "1";
  const parts = [
    isAbsolute(binary) ? dirname(binary) : "",
    ...(await loginShellPath()).split(delimiter),
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local", "bin"),
    ...EXTRA_DIRS,
  ].filter((part) => part !== "");
  env.PATH = [...new Set(parts)].join(delimiter);
  return env;
}
