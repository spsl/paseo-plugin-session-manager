import { describe, expect, it } from "vitest";
import {
  agentModeArgs,
  agentThinkingArgs,
  isSafeOptionId,
  setAgentModeViaCli,
  setAgentThinkingViaCli,
} from "./agent-cli";

describe("isSafeOptionId", () => {
  it("accepts plain identifiers", () => {
    expect(isSafeOptionId("default")).toBe(true);
    expect(isSafeOptionId("plan")).toBe(true);
    expect(isSafeOptionId("claude-4.5")).toBe(true);
    expect(isSafeOptionId("think:high")).toBe(true);
    expect(isSafeOptionId("a_b.c")).toBe(true);
  });

  it("rejects flags, empties, spaces and injection", () => {
    expect(isSafeOptionId("")).toBe(false);
    expect(isSafeOptionId("--verbose")).toBe(false);
    expect(isSafeOptionId("-x")).toBe(false);
    expect(isSafeOptionId("a b")).toBe(false);
    expect(isSafeOptionId("a;rm -rf")).toBe(false);
    expect(isSafeOptionId("a\nb")).toBe(false);
    expect(isSafeOptionId("a'")).toBe(false);
  });
});

describe("agent cli args", () => {
  it("assembles mode and thinking argv", () => {
    expect(agentModeArgs("abc123", "plan")).toEqual(["agent", "mode", "abc123", "plan"]);
    expect(agentThinkingArgs("abc123", "high")).toEqual([
      "agent",
      "update",
      "abc123",
      "--thinking",
      "high",
    ]);
  });
});

describe("unsafe ids never spawn", () => {
  it("rejects unsafe agent or option ids without calling the CLI", async () => {
    expect(await setAgentModeViaCli("bad id", "plan")).toEqual({
      ok: false,
      reason: "无效的模式参数",
    });
    expect(await setAgentModeViaCli("abc123", "--rm")).toEqual({
      ok: false,
      reason: "无效的模式参数",
    });
    expect(await setAgentThinkingViaCli("abc123", "x;y")).toEqual({
      ok: false,
      reason: "无效的思考档位参数",
    });
    expect(await setAgentThinkingViaCli("a;b", "high")).toEqual({
      ok: false,
      reason: "无效的思考档位参数",
    });
  });
});
