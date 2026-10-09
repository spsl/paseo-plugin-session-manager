import { describe, expect, it } from "vitest";
import { isSafeAgentId, stopAgentViaCli } from "./stop-agent";

describe("stop agent", () => {
  it("accepts uuid-like ids only", () => {
    expect(isSafeAgentId("a038fee1-5a85-4e60-b47b-7a2b19a1b309")).toBe(true);
    expect(isSafeAgentId("--all")).toBe(false);
    expect(isSafeAgentId("a b")).toBe(false);
    expect(isSafeAgentId("")).toBe(false);
  });

  it("rejects unsafe ids without spawning", async () => {
    await expect(stopAgentViaCli("--all")).resolves.toMatchObject({ ok: false });
  });
});
