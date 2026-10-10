/**
 * Direct Magpie adapter: one OpenAI-compatible chat completion against the local
 * proxy. No CLI, no agent loop - the analysis is a single request.
 *
 * Magpie is OpenAI-compatible, so the response shape is the standard one:
 * `choices[0].message.content` holds the JSON object.
 */
import type { AnalysisConfig } from "../../shared/analysis-config";
import type { Analysis } from "../../shared/types";
import { parseAnalysisOutput } from "./output";
import { buildAnalysisPrompt, buildAnalysisSchema, type AnalyzerInput } from "./prompt";

export type MagpieRunConfig = AnalysisConfig & {
  timeoutMs?: number;
  /** Overridable for tests and non-default proxy ports. */
  baseUrl?: string;
  /** Optional bearer token; Magpie ignores it but proxies behind auth may not. */
  apiKey?: string;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
};

export const DEFAULT_MAGPIE_BASE_URL = "http://127.0.0.1:3425/v1";
export const DEFAULT_MAGPIE_TIMEOUT_MS = 120_000;

type ChatCompletion = {
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  error?: { message?: string };
};

/**
 * The answer is a small fixed object, but reasoning models spend this budget on
 * hidden thinking first, so it has to stay well clear of a truncation that would
 * silently eat the JSON.
 */
const MAX_COMPLETION_TOKENS = 24_000;

export type MagpieRequest = {
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort: string | null;
  systemPrompt: string | null;
  input: AnalyzerInput;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
};

/** The request body as sent to `/chat/completions`. */
export function buildMagpieRequest(args: MagpieRequest): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
} {
  const schema = buildAnalysisSchema();
  return {
    url: `${args.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    headers: {
      "content-type": "application/json",
      ...(args.apiKey.trim() === "" ? {} : { authorization: `Bearer ${args.apiKey.trim()}` }),
    },
    body: {
      model: args.model,
      messages: [
        { role: "system", content: args.systemPrompt?.trim() || buildSystemPrompt() },
        { role: "user", content: buildAnalysisPrompt(args.input, schema, args.systemPrompt) },
      ],
      // The schema is also spelled out in the prompt; json_object keeps the
      // reply parseable without depending on strict structured output support.
      response_format: { type: "json_object" },
      ...(args.reasoningEffort === null
        ? {}
        : { reasoning_effort: args.reasoningEffort }),
      max_tokens: MAX_COMPLETION_TOKENS,
    },
  };
}

function buildSystemPrompt(): string {
  return "你是会话状态分析器，只输出符合给定 JSON Schema 的 JSON 对象。";
}

function conciseMagpieError(status: number, text: string): string {
  const detail = text.trim().split("\n").at(-1)?.slice(0, 280);
  if (status === 404) {
    return `Magpie 没有该模型：${detail ?? status}`;
  }
  return detail === undefined || detail === ""
    ? `Magpie 请求失败（HTTP ${status}）`
    : `Magpie 请求失败（HTTP ${status}）：${detail}`;
}

/** Runs one analysis completion; rejects with a short Chinese message. */
export async function analyzeWithMagpie(args: MagpieRequest): Promise<Analysis> {
  const { url, headers, body } = buildMagpieRequest(args);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const doFetch = args.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Magpie 分析超时（${Math.round(args.timeoutMs / 1000)} 秒）`);
    }
    throw new Error(`无法连接 Magpie：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(conciseMagpieError(response.status, text));
  }
  let payload: ChatCompletion;
  try {
    payload = JSON.parse(text) as ChatCompletion;
  } catch {
    throw new Error("Magpie 返回的不是 JSON");
  }
  if (payload.error?.message) {
    throw new Error(payload.error.message.slice(0, 280));
  }
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== "string" || content.trim() === "") {
    throw new Error(
      choice?.finish_reason === "length"
        ? "Magpie 输出被截断，请提高超时或换用更快的模型"
        : "Magpie 返回内容为空",
    );
  }
  return parseAnalysisOutput(content);
}

/** The adapter the service uses; mirrors `Analyzer` without the CLI plumbing. */
export class MagpieAnalyzer {
  constructor(private readonly options: { baseUrl?: string; apiKey?: string } = {}) {}

  async analyze(input: AnalyzerInput, config: MagpieRunConfig): Promise<Analysis> {
    return analyzeWithMagpie({
      baseUrl: config.baseUrl ?? this.options.baseUrl ?? DEFAULT_MAGPIE_BASE_URL,
      apiKey: this.options.apiKey ?? "",
      model: config.model,
      reasoningEffort: config.thinkingLevel ?? null,
      systemPrompt: config.systemPrompt ?? null,
      input,
      timeoutMs: config.timeoutMs ?? DEFAULT_MAGPIE_TIMEOUT_MS,
      fetchImpl: config.fetchImpl,
    });
  }
}
