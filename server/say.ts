/**
 * The daemon Mac's `say`, driven for its voices rather than its speaker: the
 * sentence goes in on stdin, a WAV comes out to a temporary file, and the
 * bytes go back to the app to play. Nothing here plays audio on the daemon.
 * Ported from the herald plugin (MIT).
 *
 * `-f -` reads the text from stdin so it never touches argv, and `[[ … ]]` is
 * stripped first because `say` reads that as embedded speech commands.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickDefaultVoice, type SpeechVoice } from "../shared/speech";

export const SAY_PATH = "/usr/bin/say";
/** `say -r` is words per minute; roughly what the default voices do unasked. */
export const DEFAULT_WPM = 175;
/** 16 kHz mono 16-bit: clear enough for speech, small on the wire. */
const DATA_FORMAT = "LEI16@16000";
export const RENDER_TIMEOUT_MS = 30_000;
const VOICE_CACHE_MS = 60_000;

export async function sayAvailable(): Promise<boolean> {
  if (process.platform !== "darwin") {
    return false;
  }
  try {
    await access(SAY_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * One voice per line: a name that may hold spaces and parentheses, whitespace,
 * a locale such as `zh_CN`, then `# ` and a sample sentence.
 */
export function parseVoiceList(output: string): SpeechVoice[] {
  const voices: SpeechVoice[] = [];
  for (const line of output.split("\n")) {
    const match = /^(\S.*?)\s+([a-z]{2,3}[_-][A-Za-z0-9_-]+)\s+#/.exec(line);
    if (match && match[1] !== undefined && match[2] !== undefined) {
      voices.push({ name: match[1].trim(), lang: match[2] });
    }
  }
  return voices;
}

export type RenderOptions = { voice: string; rate: number };

export function sayArguments(options: RenderOptions, outFile: string): string[] {
  const args = ["-o", outFile, "--file-format=WAVE", `--data-format=${DATA_FORMAT}`, "-f", "-"];
  const voice = options.voice.trim();
  if (voice !== "") {
    args.push("-v", voice);
  }
  if (options.rate !== 1) {
    args.push("-r", String(Math.round(DEFAULT_WPM * options.rate)));
  }
  return args;
}

/** Text as `say` should read it: no embedded-command brackets, one line. */
export function speakable(text: string): string {
  return text.replace(/\[\[|\]\]/g, " ").replace(/\s+/g, " ").trim();
}

type RunResult = { code: number | null; stdout: string; stderr: string };

function run(args: string[], input: string | null): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(SAY_PATH, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`say 未在 ${RENDER_TIMEOUT_MS / 1000} 秒内完成`));
    }, RENDER_TIMEOUT_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    if (input === null) {
      child.stdin.end();
    } else {
      child.stdin.end(input, "utf8");
    }
  });
}

export async function listSayVoices(): Promise<SpeechVoice[]> {
  const result = await run(["-v", "?"], null);
  if (result.code !== 0) {
    throw new Error(`say -v ? 失败：${result.stderr.trim() || `exit ${result.code}`}`);
  }
  return parseVoiceList(result.stdout);
}

let voiceCache: { at: number; voices: SpeechVoice[] } | null = null;

async function cachedVoices(): Promise<SpeechVoice[]> {
  if (voiceCache && Date.now() - voiceCache.at < VOICE_CACHE_MS) {
    return voiceCache.voices;
  }
  const voices = await listSayVoices();
  voiceCache = { at: Date.now(), voices };
  return voices;
}

/** An empty setting means a Chinese voice when one is installed, else the system default. */
export async function resolveVoice(voice: string): Promise<string> {
  if (voice.trim() !== "") {
    return voice.trim();
  }
  try {
    return pickDefaultVoice(await cachedVoices());
  } catch {
    return "";
  }
}

export type RenderedSpeech = { mimeType: string; base64: string };

/**
 * A voice `say` does not know is not an error: it complains and renders with
 * the default voice, exit code 0. Left alone, so a removed voice never silences
 * the plugin.
 */
export async function renderWithSay(text: string, options: RenderOptions): Promise<RenderedSpeech> {
  const spoken = speakable(text);
  if (spoken === "") {
    throw new Error("没有可播报的内容");
  }
  const voice = await resolveVoice(options.voice);
  const outFile = join(tmpdir(), `session-manager-${randomUUID()}.wav`);
  try {
    const result = await run(sayArguments({ voice, rate: options.rate }, outFile), `${spoken}\n`);
    if (result.code !== 0) {
      throw new Error(`say 失败：${result.stderr.trim() || `exit ${result.code}`}`);
    }
    const bytes = await readFile(outFile);
    return { mimeType: "audio/wav", base64: bytes.toString("base64") };
  } finally {
    await unlink(outFile).catch(() => undefined);
  }
}
