import { describe, expect, it } from "vitest";
import { fuzzyScore, searchEntries, type SearchEntry } from "./model-search";

const models: SearchEntry[] = [
  { id: "group/openai-gpt-6.1-sol", label: "group/openai-gpt-6.1-sol · 922K · 128K", provider: "magpie" },
  { id: "group/auto-gpt-5-6-terra", label: "group/auto-gpt-5-6-terra · 1.1M · 128K", provider: "magpie" },
  { id: "antigravity/gemini-3.8-flash", label: "antigravity/gemini-3.8-flash · 1.0M · 65.5K", provider: "magpie" },
  { id: "antigravity/gemini-pro-agent", label: "antigravity/gemini-pro-agent · 1.0M · 65.5K", provider: "magpie" },
  { id: "yiwise/Codex-Proxy/gpt-5.6-luna", label: "yiwise/Codex-Proxy/gpt-5.6-luna · 272K · 128K", provider: "magpie" },
];

describe("fuzzyScore", () => {
  it("matches an in-order subsequence", () => {
    expect(fuzzyScore("g6s", "group/openai-gpt-6.1-sol")).toBeGreaterThan(0);
    expect(fuzzyScore("gemini", "antigravity/gemini-3.8-flash")).toBeGreaterThan(0);
  });

  it("rejects characters that are out of order or absent", () => {
    expect(fuzzyScore("sg6", "group/openai-gpt-6.1-sol")).toBe(-1);
    expect(fuzzyScore("zzz", "group/openai-gpt-6.1-sol")).toBe(-1);
  });

  it("is case-insensitive", () => {
    expect(fuzzyScore("GEMINI", "antigravity/gemini-3.8-flash")).toBe(
      fuzzyScore("gemini", "antigravity/gemini-3.8-flash"),
    );
  });

  it("treats an empty query as neutral", () => {
    expect(fuzzyScore("  ", "anything")).toBe(0);
  });

  it("prefers a segment start over a mid-word hit", () => {
    const segmentStart = fuzzyScore("gpt", "group/openai-gpt-6.1-sol");
    const midWord = fuzzyScore("pt", "group/openai-gpt-6.1-sol");
    expect(segmentStart).toBeGreaterThan(midWord);
  });
});

describe("searchEntries", () => {
  it("returns everything for an empty query", () => {
    expect(searchEntries(models, "")).toEqual(models);
    expect(searchEntries(models, "   ")).toEqual(models);
  });

  it("narrows to matches", () => {
    expect(searchEntries(models, "gemini").map((m) => m.id)).toEqual([
      "antigravity/gemini-3.8-flash",
      "antigravity/gemini-pro-agent",
    ]);
  });

  it("matches on the id and on the provider", () => {
    expect(searchEntries(models, "luna").map((m) => m.id)).toEqual([
      "yiwise/Codex-Proxy/gpt-5.6-luna",
    ]);
    expect(searchEntries(models, "magpie")).toHaveLength(models.length);
  });

  it("finds by an abbreviated subsequence", () => {
    const found = searchEntries(models, "g6s").map((m) => m.id);
    expect(found).toContain("group/openai-gpt-6.1-sol");
  });

  it("returns nothing for a query that matches no model", () => {
    expect(searchEntries(models, "nonexistent")).toEqual([]);
  });

  it("does not mutate the input", () => {
    const copy = [...models];
    searchEntries(models, "gpt");
    expect(models).toEqual(copy);
  });
});
