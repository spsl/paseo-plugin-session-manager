/**
 * Renders mermaid source to PNG on the daemon machine via the plugin's own
 * `node_modules/.bin/mmdc` (mermaid-cli + a local Chrome; puppeteer's bundled
 * download is skipped at install time). The client gets base64 + logical size
 * and draws it with RN <Image>; no DOM/svg code ever reaches Hermes.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PLUGIN_ID, paseoHome } from "./data-dir";

export const MAX_MERMAID_CHARS = 20_000;
export const RENDER_TIMEOUT_MS = 20_000;
/** mmdc renders at this scale; reported width/height are physical pixels / it. */
export const PIXEL_SCALE = 2;
const CACHE_LIMIT = 50;
const MAX_CONCURRENT = 2;
const ERROR_LIMIT = 400;

export type MermaidTheme = "light" | "dark";
export type MermaidResult =
  | { ok: true; png: string; width: number; height: number }
  | { ok: false; error: string };

/**
 * mmdc ships with the plugin; call it directly so no `npx` lookup can hit the
 * network. The daemon loads this code as a bundle where `import.meta.url` is
 * undefined, so the plugin root is probed lazily at render time instead.
 */
export const MMDC_MISSING_ERROR = "未找到 mmdc，请在插件目录执行 npm install";

// ---------------------------------------------------------------- pure helpers

/** Width/height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) return null;
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) return null;
  }
  // First chunk must be IHDR ("IHDR" at offset 12).
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const SYSTEM_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const CHROME_FOR_TESTING_BIN =
  "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

/**
 * Browser executables inside a puppeteer cache root, newest versions first:
 * `<family>/<version>/<platform-dir>/<binary>`. `readdir` is injected for tests.
 */
export function cachedBrowserPaths(
  cacheRoot: string,
  readdir: (dir: string) => string[],
): string[] {
  const families = [
    { dir: "chrome-headless-shell", bin: "chrome-headless-shell" },
    { dir: "chrome", bin: CHROME_FOR_TESTING_BIN },
  ];
  const out: string[] = [];
  for (const family of families) {
    let versions: string[];
    try {
      versions = readdir(join(cacheRoot, family.dir));
    } catch {
      continue;
    }
    for (const version of versions.slice().sort().reverse()) {
      let platformDirs: string[];
      try {
        platformDirs = readdir(join(cacheRoot, family.dir, version));
      } catch {
        continue;
      }
      for (const platformDir of platformDirs) {
        out.push(join(cacheRoot, family.dir, version, platformDir, family.bin));
      }
    }
  }
  return out;
}

/** Ordered Chrome probe list: system Chrome first, then the puppeteer cache. */
export function chromeCandidates(
  homeDir: string,
  readdir: (dir: string) => string[],
): string[] {
  return [SYSTEM_CHROME, ...cachedBrowserPaths(join(homeDir, ".cache", "puppeteer"), readdir)];
}

/** First candidate that exists, or null so puppeteer can fall back to its own. */
export function pickChrome(candidates: string[], exists: (path: string) => boolean): string | null {
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** mmdc argv; `puppeteerConfig` is the -p file path, or null to omit the flag. */
export function mmdcArguments(
  input: string,
  output: string,
  theme: MermaidTheme,
  puppeteerConfig: string | null,
): string[] {
  const args = [
    "-i",
    input,
    "-o",
    output,
    "-t",
    theme === "dark" ? "dark" : "default",
    "-b",
    "transparent",
    "-s",
    String(PIXEL_SCALE),
  ];
  if (puppeteerConfig !== null) args.push("-p", puppeteerConfig);
  return args;
}

/** `<root>/node_modules/.bin/mmdc` for a plugin root candidate. */
export function mmdcBinForRoot(root: string): string {
  return join(root, "node_modules", ".bin", "mmdc");
}

/** `plugins[pluginId].path` from parsed daemon config JSON; null when absent/malformed. */
export function pluginPathFromConfig(config: unknown, pluginId: string): string | null {
  if (config === null || typeof config !== "object") return null;
  const plugins = (config as { plugins?: unknown }).plugins;
  if (plugins === null || typeof plugins !== "object") return null;
  const entry = (plugins as Record<string, unknown>)[pluginId];
  if (entry === null || typeof entry !== "object") return null;
  const path = (entry as { path?: unknown }).path;
  return typeof path === "string" && path !== "" ? path : null;
}

/** Plugin roots to probe for mmdc, in order: subprocess cwd, then the configured path. */
export function pluginRootCandidates(cwd: string, configuredPath: string | null): string[] {
  const roots = [cwd];
  if (configuredPath !== null && configuredPath !== cwd) roots.push(configuredPath);
  return roots;
}

/** First candidate root containing `node_modules/.bin/mmdc`, or null. */
export function resolveMmdcBin(roots: string[], exists: (path: string) => boolean): string | null {
  for (const root of roots) {
    const bin = mmdcBinForRoot(root);
    if (exists(bin)) return bin;
  }
  return null;
}

/** Useful part of mmdc stderr: drop stack-trace lines, cap the length. */
export function cleanError(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map(function strip(line) {
      return line.trimEnd();
    })
    .filter(function keep(line) {
      return line.trim() !== "" && !/^\s+at\s/.test(line);
    });
  const text = lines.join("\n").trim();
  const message = text === "" ? "mermaid-cli 渲染失败" : text;
  return message.length > ERROR_LIMIT ? `${message.slice(0, ERROR_LIMIT)}…` : message;
}

/** Tiny LRU keyed by string; `get` refreshes recency. */
export class LruCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

// ---------------------------------------------------------------- renderer

type RunResult = { code: number | null; stderr: string };
/** Spawns mmdc with argv; resolves with exit code + stderr. Injectable for tests. */
export type MmdcRun = (bin: string, args: string[]) => Promise<RunResult>;

function runMmdc(bin: string, args: string[]): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`图表渲染超时（${RENDER_TIMEOUT_MS / 1000} 秒）`));
    }, RENDER_TIMEOUT_MS);
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

function defaultChrome(): string | null {
  return pickChrome(chromeCandidates(homedir(), readdirSync), existsSync);
}

/** The plugin root from the daemon's config.json; null on any read/parse failure. */
function configuredPluginRoot(): string | null {
  try {
    const raw = readFileSync(join(paseoHome(), "config.json"), "utf8");
    return pluginPathFromConfig(JSON.parse(raw), PLUGIN_ID);
  } catch {
    return null;
  }
}

/** Lazily finds mmdc once; a null answer is cached too. Never throws. */
function defaultBinResolver(): () => string | null {
  let resolved: string | null | undefined;
  return function resolveBin(): string | null {
    if (resolved === undefined) {
      try {
        resolved = resolveMmdcBin(
          pluginRootCandidates(process.cwd(), configuredPluginRoot()),
          existsSync,
        );
      } catch {
        resolved = null;
      }
    }
    return resolved;
  };
}

export interface MermaidRendererOverrides {
  resolveBin?: () => string | null;
  run?: MmdcRun;
  findChrome?: () => string | null;
  cacheLimit?: number;
  maxConcurrent?: number;
}

export interface MermaidRenderer {
  render(code: string, theme: MermaidTheme): Promise<MermaidResult>;
}

/**
 * Cache by sha256(theme+source) (failures cached too, so a broken diagram in a
 * streaming session does not keep spawning Chrome), same-key in-flight dedup,
 * and a small queue so at most `maxConcurrent` mmdc processes run at once.
 */
export function createMermaidRenderer(overrides: MermaidRendererOverrides = {}): MermaidRenderer {
  const resolveBin = overrides.resolveBin ?? defaultBinResolver();
  const run = overrides.run ?? runMmdc;
  const findChrome = overrides.findChrome ?? defaultChrome;
  const maxConcurrent = overrides.maxConcurrent ?? MAX_CONCURRENT;
  const cache = new LruCache<MermaidResult>(overrides.cacheLimit ?? CACHE_LIMIT);
  const inflight = new Map<string, Promise<MermaidResult>>();
  const queue: Array<() => void> = [];
  let running = 0;

  function enqueue(job: () => Promise<MermaidResult>): Promise<MermaidResult> {
    return new Promise<MermaidResult>((resolve, reject) => {
      const start = function start(): void {
        running++;
        job().then(resolve, reject).finally(function done() {
          running--;
          const next = queue.shift();
          if (next) next();
        });
      };
      if (running < maxConcurrent) start();
      else queue.push(start);
    });
  }

  async function renderOnce(code: string, theme: MermaidTheme): Promise<MermaidResult> {
    const bin = resolveBin();
    if (bin === null) {
      return { ok: false, error: MMDC_MISSING_ERROR };
    }
    const dir = await mkdtemp(join(tmpdir(), "session-manager-mmd-"));
    try {
      const input = join(dir, "diagram.mmd");
      const output = join(dir, "diagram.png");
      await writeFile(input, code, "utf8");
      const chrome = findChrome();
      let puppeteerConfig: string | null = null;
      if (chrome !== null) {
        puppeteerConfig = join(dir, "puppeteer.json");
        await writeFile(
          puppeteerConfig,
          JSON.stringify({ executablePath: chrome, args: ["--no-sandbox"] }),
          "utf8",
        );
      }
      const result = await run(bin, mmdcArguments(input, output, theme, puppeteerConfig));
      if (result.code !== 0) {
        return { ok: false, error: cleanError(result.stderr) };
      }
      const png = await readFile(output);
      const size = pngSize(png);
      if (size === null) {
        return { ok: false, error: "mermaid-cli 未产出有效的 PNG" };
      }
      return {
        ok: true,
        png: png.toString("base64"),
        width: Math.round(size.width / PIXEL_SCALE),
        height: Math.round(size.height / PIXEL_SCALE),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  function render(code: string, theme: MermaidTheme): Promise<MermaidResult> {
    if (code.trim() === "") {
      return Promise.resolve({ ok: false, error: "mermaid 代码为空" });
    }
    if (code.length > MAX_MERMAID_CHARS) {
      return Promise.resolve({
        ok: false,
        error: `mermaid 代码过长（${code.length} 字符，上限 ${MAX_MERMAID_CHARS}）`,
      });
    }
    const key = createHash("sha256").update(`${theme}\n${code}`).digest("hex");
    const hit = cache.get(key);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    const promise = enqueue(function job() {
      return renderOnce(code, theme);
    })
      .then(function cached(result) {
        cache.set(key, result);
        return result;
      })
      .finally(function settled() {
        inflight.delete(key);
      });
    inflight.set(key, promise);
    return promise;
  }

  return { render };
}

const defaultRenderer = createMermaidRenderer();

export function renderMermaid(code: string, theme: MermaidTheme): Promise<MermaidResult> {
  return defaultRenderer.render(code, theme);
}
