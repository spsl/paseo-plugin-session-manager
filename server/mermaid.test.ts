import { writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  cachedBrowserPaths,
  chromeCandidates,
  cleanError,
  createMermaidRenderer,
  LruCache,
  MAX_MERMAID_CHARS,
  MMDC_MISSING_ERROR,
  mmdcArguments,
  mmdcBinForRoot,
  pickChrome,
  pluginPathFromConfig,
  pluginRootCandidates,
  pngSize,
  resolveMmdcBin,
} from "./mermaid";

const FAKE_BIN = "/plugin/root/node_modules/.bin/mmdc";
const fakeBin = () => FAKE_BIN;

/** Minimal PNG: signature + IHDR chunk header + width/height fields. */
function fakePng(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8); // IHDR data length
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** Fake mmdc run: writes a fake PNG to the -o path, succeeds. */
function okRun(width = 200, height = 100) {
  const calls: string[][] = [];
  const run = async function run(_bin: string, args: string[]) {
    calls.push(args);
    const out = args[args.indexOf("-o") + 1];
    await writeFile(out, fakePng(width, height));
    return { code: 0, stderr: "" };
  };
  return { run, calls };
}

describe("pngSize", () => {
  it("reads IHDR width and height", () => {
    expect(pngSize(fakePng(640, 480))).toEqual({ width: 640, height: 480 });
  });
  it("rejects non-PNG and truncated input", () => {
    expect(pngSize(Buffer.from("not a png at all, no sir"))).toBeNull();
    expect(pngSize(fakePng(1, 1).subarray(0, 10))).toBeNull();
    const broken = fakePng(1, 1);
    broken[13] = 0x00;
    expect(pngSize(broken)).toBeNull();
  });
});

describe("chrome detection", () => {
  const layout: Record<string, string[]> = {
    "/cache/chrome-headless-shell": ["mac_arm-131.0.0", "mac_arm-152.0.0"],
    "/cache/chrome-headless-shell/mac_arm-131.0.0": ["chrome-headless-shell-mac-arm64"],
    "/cache/chrome-headless-shell/mac_arm-152.0.0": ["chrome-headless-shell-mac-arm64"],
    "/cache/chrome": ["mac_arm-152.0.0"],
    "/cache/chrome/mac_arm-152.0.0": ["chrome-mac-arm64"],
  };
  const readdir = (dir: string): string[] => {
    const entries = layout[dir];
    if (!entries) throw new Error("ENOENT");
    return entries;
  };

  it("lists cached browsers newest first, headless shell before chrome", () => {
    expect(cachedBrowserPaths("/cache", readdir)).toEqual([
      "/cache/chrome-headless-shell/mac_arm-152.0.0/chrome-headless-shell-mac-arm64/chrome-headless-shell",
      "/cache/chrome-headless-shell/mac_arm-131.0.0/chrome-headless-shell-mac-arm64/chrome-headless-shell",
      "/cache/chrome/mac_arm-152.0.0/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    ]);
  });
  it("puts system Chrome ahead of the puppeteer cache", () => {
    const candidates = chromeCandidates("/home/u", function read(dir) {
      return readdir(dir.replace("/home/u/.cache/puppeteer", "/cache"));
    });
    expect(candidates[0]).toBe(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(candidates).toHaveLength(4);
  });
  it("picks the first existing candidate and falls back to null", () => {
    const candidates = ["/a", "/b", "/c"];
    expect(pickChrome(candidates, (p) => p === "/b")).toBe("/b");
    expect(pickChrome(candidates, () => false)).toBeNull();
  });
});

describe("mmdcArguments", () => {
  it("maps themes and includes puppeteer config only when given", () => {
    expect(mmdcArguments("in.mmd", "out.png", "dark", "/tmp/pptr.json")).toEqual([
      "-i", "in.mmd", "-o", "out.png", "-t", "dark",
      "-b", "transparent", "-s", "2", "-p", "/tmp/pptr.json",
    ]);
    const light = mmdcArguments("in.mmd", "out.png", "light", null);
    expect(light).toContain("default");
    expect(light).not.toContain("-p");
  });
});

describe("mmdc resolution", () => {
  it("reads the plugin path from daemon config JSON", () => {
    const config = {
      plugins: {
        "session-manager": { source: "directory", path: "/plugin/root", enabled: true },
        other: { source: "registry" },
      },
    };
    expect(pluginPathFromConfig(config, "session-manager")).toBe("/plugin/root");
    expect(pluginPathFromConfig(config, "other")).toBeNull();
    expect(pluginPathFromConfig({ plugins: null }, "session-manager")).toBeNull();
    expect(pluginPathFromConfig({}, "session-manager")).toBeNull();
    expect(pluginPathFromConfig("junk", "session-manager")).toBeNull();
    expect(pluginPathFromConfig({ plugins: { "session-manager": { path: "" } } }, "session-manager")).toBeNull();
  });
  it("orders candidates cwd first, then configured path, deduped", () => {
    expect(pluginRootCandidates("/cwd", "/configured")).toEqual(["/cwd", "/configured"]);
    expect(pluginRootCandidates("/cwd", "/cwd")).toEqual(["/cwd"]);
    expect(pluginRootCandidates("/cwd", null)).toEqual(["/cwd"]);
  });
  it("resolves the first root containing node_modules/.bin/mmdc", () => {
    expect(mmdcBinForRoot("/r")).toBe("/r/node_modules/.bin/mmdc");
    const exists = (p: string) => p === "/b/node_modules/.bin/mmdc";
    expect(resolveMmdcBin(["/a", "/b", "/c"], exists)).toBe("/b/node_modules/.bin/mmdc");
    expect(resolveMmdcBin(["/a"], exists)).toBeNull();
  });
});

describe("cleanError", () => {
  it("drops stack lines and truncates", () => {
    const stderr = "Error: Parse error on line 2\n    at Parser.parse (x.js:1)\n\nbad token";
    expect(cleanError(stderr)).toBe("Error: Parse error on line 2\nbad token");
    const long = "x".repeat(1000);
    expect(cleanError(long)).toHaveLength(401);
  });
  it("has a fallback for empty stderr", () => {
    expect(cleanError("")).toBe("mermaid-cli 渲染失败");
  });
});

describe("LruCache", () => {
  it("evicts the oldest entry and refreshes on get", () => {
    const cache = new LruCache<number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
    expect(cache.size).toBe(2);
  });
});

describe("createMermaidRenderer", () => {
  const CODE = "graph TD; A-->B";

  it("returns base64 PNG with logical (scaled-down) size", async () => {
    const { run, calls } = okRun(400, 220);
    const renderer = createMermaidRenderer({ resolveBin: fakeBin, run, findChrome: () => null });
    const result = await renderer.render(CODE, "light");
    expect(calls).toHaveLength(1);
    expect(result).toEqual({
      ok: true,
      png: fakePng(400, 220).toString("base64"),
      width: 200,
      height: 110,
    });
  });

  it("passes a puppeteer config only when Chrome is found", async () => {
    const { run, calls } = okRun();
    const renderer = createMermaidRenderer({
      resolveBin: fakeBin,
      run,
      findChrome: () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
    await renderer.render(CODE, "dark");
    const args = calls[0];
    expect(args).toContain("-p");
    expect(args).toContain("dark");
    const noChrome = createMermaidRenderer({ resolveBin: fakeBin, run, findChrome: () => null });
    await noChrome.render("graph TD; X-->Y", "dark");
    expect(calls[1]).not.toContain("-p");
  });

  it("caches results and dedups in-flight renders of the same key", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runs = 0;
    const run = async function run(_bin: string, args: string[]) {
      runs++;
      await gate;
      await writeFile(args[args.indexOf("-o") + 1], fakePng(10, 10));
      return { code: 0, stderr: "" };
    };
    const renderer = createMermaidRenderer({ resolveBin: fakeBin, run, findChrome: () => null });
    const first = renderer.render(CODE, "light");
    const second = renderer.render(CODE, "light");
    release!();
    const [a, b] = await Promise.all([first, second]);
    expect(runs).toBe(1);
    expect(a).toEqual(b);
    await renderer.render(CODE, "light"); // cache hit
    expect(runs).toBe(1);
    await renderer.render(CODE, "dark"); // theme is part of the key
    expect(runs).toBe(2);
  });

  it("limits concurrent mmdc processes", async () => {
    let active = 0;
    let peak = 0;
    const run = async function run(_bin: string, args: string[]) {
      active++;
      if (active > peak) peak = active;
      await new Promise((resolve) => setTimeout(resolve, 10));
      await writeFile(args[args.indexOf("-o") + 1], fakePng(10, 10));
      active--;
      return { code: 0, stderr: "" };
    };
    const renderer = createMermaidRenderer({
      resolveBin: fakeBin,
      run,
      findChrome: () => null,
      maxConcurrent: 1,
    });
    await Promise.all([
      renderer.render("graph TD; A-->B", "light"),
      renderer.render("graph TD; C-->D", "light"),
      renderer.render("graph TD; E-->F", "light"),
    ]);
    expect(peak).toBe(1);
  });

  it("returns ok:false with cleaned stderr on failure and caches it", async () => {
    let runs = 0;
    const run = async function run() {
      runs++;
      return { code: 1, stderr: "Error: Parse error on line 1\n    at x (y.js:1)" };
    };
    const renderer = createMermaidRenderer({ resolveBin: fakeBin, run, findChrome: () => null });
    const result = await renderer.render("not mermaid", "light");
    expect(result).toEqual({ ok: false, error: "Error: Parse error on line 1" });
    await renderer.render("not mermaid", "light");
    expect(runs).toBe(1);
  });

  it("rejects empty and oversized source without spawning", async () => {
    const { run, calls } = okRun();
    const renderer = createMermaidRenderer({ resolveBin: fakeBin, run, findChrome: () => null });
    expect((await renderer.render("   ", "light")).ok).toBe(false);
    const big = "x".repeat(MAX_MERMAID_CHARS + 1);
    const result = await renderer.render(big, "light");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("过长");
    expect(calls).toHaveLength(0);
  });

  it("returns the missing-mmdc error when no bin resolves, without spawning", async () => {
    const { run, calls } = okRun();
    const renderer = createMermaidRenderer({
      resolveBin: () => null,
      run,
      findChrome: () => null,
    });
    const result = await renderer.render(CODE, "light");
    expect(result).toEqual({ ok: false, error: MMDC_MISSING_ERROR });
    expect(calls).toHaveLength(0);
  });
});
