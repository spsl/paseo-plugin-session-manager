import { describe, expect, it } from "vitest";
import { isExcludedAgent, parseExclusions } from "./agent-filter";

describe("parseExclusions", () => {
  it("splits on commas and whitespace and drops blanks", () => {
    expect(parseExclusions(" a, b\n c=1 ,, ")).toEqual([
      { key: "a", value: null },
      { key: "b", value: null },
      { key: "c", value: "1" },
    ]);
    expect(parseExclusions("")).toEqual([]);
    expect(parseExclusions(undefined)).toEqual([]);
    expect(parseExclusions("=x")).toEqual([]);
  });
});

describe("isExcludedAgent", () => {
  it("matches label keys exactly", () => {
    const rules = parseExclusions("herald.role");
    expect(isExcludedAgent({ "herald.role": "summarizer" }, rules)).toBe(true);
    expect(isExcludedAgent({ "herald.roles": "x" }, rules)).toBe(false);
    expect(isExcludedAgent({}, rules)).toBe(false);
    expect(isExcludedAgent(null, rules)).toBe(false);
  });

  it("matches key=value pairs exactly", () => {
    const rules = parseExclusions("herald.role=summarizer");
    expect(isExcludedAgent({ "herald.role": "summarizer" }, rules)).toBe(true);
    expect(isExcludedAgent({ "herald.role": "other" }, rules)).toBe(false);
  });

  it("excludes nothing with no rules", () => {
    expect(isExcludedAgent({ a: "b" }, [])).toBe(false);
  });
});
