/**
 * `pi --list-models` output parsing. The table is plain padded stdout (no ANSI,
 * even in a TTY), so whitespace splitting is enough. Server-side only, because
 * just the daemon can run the binary.
 *
 *   provider        model                  context  max-out  thinking  images
 *   magpie          antigravity/gemini-x    1.0M     65.5K    yes       yes
 */
import { buildAnalyzerEnv, resolveAnalyzerBinary, spawnBounded } from "./cli";

export type PiModelOption = {
  /** The `--model` value; `provider/model` for provider-owned ids. */
  id: string;
  /** Row text as printed, minus the provider column. */
  label: string;
  provider: string;
  /** Pi's own `reasoning` flag: whether this model accepts a thinking level. */
  thinking: boolean;
};

export type PiModelList = {
  models: PiModelOption[];
  /** Set when the CLI ran but reported no usable rows. */
  problem: string | null;
};

/** Same shape, for the Magpie adapter's `/v1/models` payload. */
export type MagpieModelList = PiModelList;

const HEADER = /^provider\s+model\s+context\s+max-out\s+thinking\s+images$/;
const ROW = /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(yes|no)\s+(yes|no)$/;
const LIST_TIMEOUT_MS = 15_000;

/**
 * The value to pass to `--model`. A bare id is ambiguous when several providers
 * expose it (pi rejects it outright), so the provider is always prefixed.
 */
export function piModelReference(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** Parses the table; unparseable rows are skipped rather than failing the run. */
export function parsePiModelList(output: string): PiModelList {
  const models: PiModelOption[] = [];
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || HEADER.test(trimmed)) {
      continue;
    }
    const match = ROW.exec(trimmed);
    if (match === null) {
      continue;
    }
    const provider = match[1];
    const model = match[2];
    const context = match[3];
    const maxOut = match[4];
    const images = match[6];
    const thinking = match[5] === "yes";
    if (provider === undefined || model === undefined) {
      continue;
    }
    models.push({
      id: piModelReference(provider, model),
      label: [model, context, maxOut, images].join(" · "),
      provider,
      thinking,
    });
  }
  return { models, problem: models.length === 0 ? "pi 未返回任何可用模型" : null };
}

/**
 * Runs `pi --list-models` through the resolved binary. Failures degrade to an
 * empty list plus a message, so the settings screen can still offer free input.
 */
export async function listPiModels(commandOverride: string): Promise<PiModelList> {
  let program: string;
  let prefixArgs: string[];
  try {
    const resolved = await resolveAnalyzerBinary("pi", commandOverride);
    program = resolved.program;
    prefixArgs = resolved.prefixArgs;
  } catch (error) {
    return { models: [], problem: error instanceof Error ? error.message : String(error) };
  }
  const result = await spawnBounded({
    program,
    args: [...prefixArgs, "--list-models"],
    env: await buildAnalyzerEnv(program),
    timeoutMs: LIST_TIMEOUT_MS,
    outputLimit: 256 * 1024,
  });
  if (result.code !== 0 || result.timedOut) {
    const detail = result.stderr.trim().split("\n").at(-1)?.slice(0, 200);
    return {
      models: [],
      problem: result.timedOut ? "pi 模型列表超时" : detail || "pi 模型列表获取失败",
    };
  }
  return parsePiModelList(result.stdout);
}

/**
 * Parses Magpie's `/v1/models` payload. Each entry is already a model, so the
 * `provider/` prefix that Pi needs is not required here.
 */
export function parseMagpieModelList(payload: unknown): MagpieModelList {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) {
    return { models: [], problem: "Magpie 模型列表格式无效" };
  }
  const models: PiModelOption[] = [];
  for (const entry of data) {
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (id === "") {
      continue;
    }
    const maxOut = typeof record.max_output_tokens === "number" ? record.max_output_tokens : null;
    const context = typeof record.context_window === "number" ? record.context_window : null;
    const label = [
      id,
      context === null ? null : formatTokens(context),
      maxOut === null ? null : formatTokens(maxOut),
    ]
      .filter((part) => part !== null)
      .join(" · ");
    models.push({ id, label, provider: "magpie", thinking: record.reasoning === true });
  }
  return { models, problem: models.length === 0 ? "Magpie 未返回任何可用模型" : null };
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    const thousands = count / 1_000;
    return `${thousands % 1 === 0 ? thousands : thousands.toFixed(1)}K`;
  }
  return String(count);
}

/** Fetches the local proxy's catalog; failures degrade to an empty list. */
export async function listMagpieModels(baseUrl: string): Promise<MagpieModelList> {
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return { models: [], problem: `Magpie 模型列表请求失败（HTTP ${response.status}）` };
    }
    return parseMagpieModelList(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { models: [], problem: "Magpie 模型列表超时" };
    }
    return {
      models: [],
      problem: `无法连接 Magpie：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
