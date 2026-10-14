import { describe, expect, it } from "vitest";
import { contextColor } from "./composer-tokens";
import type { ComposerPalette } from "./composer-tokens";

const palette = {
  destructive: "destructive",
  amber: "amber500",
  foregroundMuted: "muted",
} as unknown as ComposerPalette;

describe("contextColor", () => {
  it("matches Paseo thresholds: >90 destructive, >=70 amber, else muted", () => {
    expect(contextColor(palette, 0)).toBe("muted");
    expect(contextColor(palette, 69)).toBe("muted");
    expect(contextColor(palette, 70)).toBe("amber500");
    expect(contextColor(palette, 89)).toBe("amber500");
    expect(contextColor(palette, 90)).toBe("amber500");
    expect(contextColor(palette, 91)).toBe("destructive");
    expect(contextColor(palette, 100)).toBe("destructive");
  });
});
