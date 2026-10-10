import { describe, expect, it } from "vitest";
import { parseMagpieModelList, parsePiModelList, piModelReference } from "./pi-models";

const HEADER = "provider        model                               context  max-out  thinking  images";

describe("pi model list", () => {
  it("skips the header and reads provider/model/thinking columns", () => {
    const result = parsePiModelList(
      [
        HEADER,
        "magpie          antigravity/gemini-3.8-flash        1.0M     65.5K    yes       yes   ",
        "magpie          antigravity/gemini-pro-agent        1.0M     65.5K    no        yes   ",
        "",
      ].join("\n"),
    );
    expect(result.problem).toBeNull();
    expect(result.models).toEqual([
      {
        id: "magpie/antigravity/gemini-3.8-flash",
        label: "antigravity/gemini-3.8-flash · 1.0M · 65.5K · yes",
        provider: "magpie",
        thinking: true,
      },
      {
        id: "magpie/antigravity/gemini-pro-agent",
        label: "antigravity/gemini-pro-agent · 1.0M · 65.5K · yes",
        provider: "magpie",
        thinking: false,
      },
    ]);
  });

  it("always prefixes the provider, since bare ids can be ambiguous", () => {
    expect(piModelReference("magpie", "factory/claude-opus-5-5")).toBe(
      "magpie/factory/claude-opus-5-5",
    );
    expect(piModelReference("openai", "gpt-5.4")).toBe("openai/gpt-5.4");
  });

  it("reports a problem when the CLI printed no usable rows", () => {
    expect(parsePiModelList(HEADER).problem).toBe("pi 未返回任何可用模型");
    expect(parsePiModelList("No models matching \"nope\"").problem).toBe("pi 未返回任何可用模型");
  });

  it("ignores unparseable lines instead of failing the run", () => {
    const result = parsePiModelList(
      [HEADER, "Warning: errors loading models.json", "custom-api-key  gpt-5.6-luna  272K  128K  yes  yes"].join(
        "\n",
      ),
    );
    expect(result.problem).toBeNull();
    expect(result.models.map((model) => model.id)).toEqual(["custom-api-key/gpt-5.6-luna"]);
  });

  it("reads the real CLI table shape", () => {
    const result = parsePiModelList(
      [
        "provider        model                               context  max-out  thinking  images",
        "magpie          antigravity/gemini-3.8-flash        1.0M     65.5K    yes       yes   ",
        "magpie          antigravity/gemini-pro-agent        1.0M     65.5K    no        yes   ",
      ].join("\n"),
    );
    expect(result.models.map((model) => model.id)).toEqual([
      "magpie/antigravity/gemini-3.8-flash",
      "magpie/antigravity/gemini-pro-agent",
    ]);
  });
});

describe("magpie model list", () => {
  it("reads /v1/models entries with context, output and reasoning flags", () => {
    const result = parseMagpieModelList({
      data: [
        {
          id: "group/openai-gpt-6.1-sol",
          context_window: 922000,
          max_output_tokens: 128000,
          reasoning: true,
        },
        { id: "antigravity/gemini-pro-agent", context_window: 1000000, reasoning: false },
      ],
    });
    expect(result.problem).toBeNull();
    expect(result.models).toEqual([
      {
        id: "group/openai-gpt-6.1-sol",
        label: "group/openai-gpt-6.1-sol · 922K · 128K",
        provider: "magpie",
        thinking: true,
      },
      {
        id: "antigravity/gemini-pro-agent",
        label: "antigravity/gemini-pro-agent · 1.0M",
        provider: "magpie",
        thinking: false,
      },
    ]);
  });

  it("reports an invalid payload", () => {
    expect(parseMagpieModelList({}).problem).toBe("Magpie 模型列表格式无效");
    expect(parseMagpieModelList({ data: [] }).problem).toBe("Magpie 未返回任何可用模型");
    expect(parseMagpieModelList({ data: [{ notAnId: 1 }] }).models).toEqual([]);
  });
});
