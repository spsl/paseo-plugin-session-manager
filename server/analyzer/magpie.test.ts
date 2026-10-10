import { describe, expect, it } from "vitest";
import type { AnalysisConfig } from "../../shared/analysis-config";
import { parseAnalysisOutput } from "./output";
import { buildMagpieRequest, analyzeWithMagpie, MagpieAnalyzer } from "./magpie";
import type { AnalyzerInput } from "./prompt";

const config: AnalysisConfig = {
  agent: "magpie",
  model: "group/openai-gpt-6.1-sol",
  thinkingLevel: "low",
  systemPrompt: null,
};

const input: AnalyzerInput = {
  session: {
    id: "s1",
    provider: "codex",
    model: null,
    cwd: "/w",
    branch: null,
    agentTitle: null,
    pendingPermission: false,
    firstUserMessage: "做事",
  },
  turns: [
    {
      id: "t1",
      dedupeKey: "t1",
      userInput: "做事",
      agentOutput: "已完成",
      outcome: "completed",
      completedAt: 1,
      contextIncomplete: false,
    },
  ],
  previousAnalysis: null,
};

const analysisJson = JSON.stringify({
  title: "完成需求实现",
  summary: "已经完成需求。",
  speech: "完成需求实现：功能已完成，无需处理。",
  goal: "完成需求",
  status: "completed",
  progress: [],
  completed: [],
  nextSteps: [],
  blockers: [],
  needsUserAttention: false,
  confidence: 0.9,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("magpie request", () => {
  it("posts a single chat completion to the local proxy", () => {
    const request = buildMagpieRequest({
      baseUrl: "http://127.0.0.1:3425/v1",
      apiKey: "",
      model: config.model,
      reasoningEffort: "low",
      systemPrompt: null,
      input,
      timeoutMs: 1000,
    });
    expect(request.url).toBe("http://127.0.0.1:3425/v1/chat/completions");
    expect(request.body).toMatchObject({
      model: "group/openai-gpt-6.1-sol",
      response_format: { type: "json_object" },
      reasoning_effort: "low",
    });
    const messages = request.body.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.content).toContain("做事");
    // No bearer header when no key is configured.
    expect(request.headers.authorization).toBeUndefined();
  });

  it("omits the effort for models that do not reason", () => {
    const request = buildMagpieRequest({
      baseUrl: "http://127.0.0.1:3425/v1",
      apiKey: "k",
      model: "m",
      reasoningEffort: null,
      systemPrompt: null,
      input,
      timeoutMs: 1000,
    });
    expect(request.body).not.toHaveProperty("reasoning_effort");
    expect(request.headers.authorization).toBe("Bearer k");
  });

  it("strips a trailing slash from the base url", () => {
    const request = buildMagpieRequest({
      baseUrl: "http://127.0.0.1:3425/v1/",
      apiKey: "",
      model: "m",
      reasoningEffort: null,
      systemPrompt: null,
      input,
      timeoutMs: 1000,
    });
    expect(request.url).toBe("http://127.0.0.1:3425/v1/chat/completions");
  });
});

describe("magpie response", () => {
  const request = {
    baseUrl: "http://127.0.0.1:3425/v1",
    apiKey: "",
    model: "m",
    reasoningEffort: null,
    systemPrompt: null,
    input,
    timeoutMs: 1000,
  };

  it("parses the completion content", async () => {
    const result = await analyzeWithMagpie({
      ...request,
      fetchImpl: async () => jsonResponse({ choices: [{ message: { content: analysisJson } }] }),
    });
    expect(result.title).toBe("完成需求实现");
    expect(result.status).toBe("completed");
  });

  it("surfaces a proxy error envelope", async () => {
    await expect(
      analyzeWithMagpie({
        ...request,
        fetchImpl: async () => jsonResponse({ error: { message: "magpie knows no model" } }),
      }),
    ).rejects.toThrow(/magpie knows no model/);
  });

  it("reports an HTTP failure with its body", async () => {
    await expect(
      analyzeWithMagpie({
        ...request,
        fetchImpl: async () => new Response("boom", { status: 502 }),
      }),
    ).rejects.toThrow(/502/);
  });

  it("rejects empty content", async () => {
    await expect(
      analyzeWithMagpie({
        ...request,
        fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "  " } }] }),
      }),
    ).rejects.toThrow(/内容为空/);
  });

  it("explains a truncated completion instead of a JSON error", async () => {
    await expect(
      analyzeWithMagpie({
        ...request,
        fetchImpl: async () =>
          jsonResponse({ choices: [{ message: { content: "" }, finish_reason: "length" }] }),
      }),
    ).rejects.toThrow(/截断/);
  });

  it("reports a timeout instead of hanging", async () => {
    await expect(
      analyzeWithMagpie({
        ...request,
        timeoutMs: 5,
        fetchImpl: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      }),
    ).rejects.toThrow(/超时/);
  });

  it("reports an unreachable proxy", async () => {
    await expect(
      analyzeWithMagpie({
        ...request,
        fetchImpl: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      }),
    ).rejects.toThrow(/无法连接 Magpie/);
  });

  it("reuses the shared output validation", async () => {
    await expect(
      analyzeWithMagpie({
        ...request,
        fetchImpl: async () => jsonResponse({ choices: [{ message: { content: "no json here" } }] }),
      }),
    ).rejects.toThrow(/JSON/);
    expect(parseAnalysisOutput(analysisJson).title).toBe("完成需求实现");
  });
});

describe("magpie analyzer", () => {
  it("sends the configured model and effort", async () => {
    const seen: { url: string; body: string }[] = [];
    const analyzer = new MagpieAnalyzer({ apiKey: "k" });
    const result = await analyzer.analyze(input, {
      ...config,
      timeoutMs: 1000,
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), body: String(init?.body ?? "") });
        return jsonResponse({ choices: [{ message: { content: analysisJson } }] });
      },
    } as never);
    expect(result.title).toBe("完成需求实现");
    expect(seen[0]?.url).toContain("/chat/completions");
    expect(seen[0]?.body).toContain("group/openai-gpt-6.1-sol");
    expect(seen[0]?.body).toContain('"reasoning_effort":"low"');
  });
});
