import { describe, expect, it } from "vitest";
import type { PluginTheme } from "@getpaseo/plugin";
import { composerPalette } from "./composer-tokens";

function theme(surface0: string, surface1: string): PluginTheme {
  return {
    colors: {
      surface0,
      surface1,
      surface2: "#222222",
      border: "#333333",
      foreground: "#eeeeee",
      foregroundMuted: "#888888",
      accent: "#3a7c5c",
      accentForeground: "#ffffff",
      statusSuccess: "#44aa44",
      statusWarning: "#ccaa33",
      statusDanger: "#cc4444",
    },
  };
}

describe("composerPalette", () => {
  it("hits every built-in palette by surface0|surface1", () => {
    const cases: [string, string, string, string, string, string][] = [
      ["#ffffff", "#fafafa", "#E4E4E7", "#D4D4D8", "#ECECF1", "#B04138"],
      ["#181B1A", "#1E2120", "#434645", "#595B5B", "#2F3534", "#C64F43"],
      ["#18181b", "#1f1f22", "#3F3F46", "#52525B", "#303036", "#C44A4A"],
      ["#161820", "#1c1e27", "#3C3E4C", "#535564", "#2E3040", "#C44A52"],
      ["#1f1f1e", "#262523", "#4A4745", "#605D5B", "#36332F", "#CF513E"],
      ["#282c34", "#2f333d", "#4A4F5E", "#5B6175", "#3F4454", "#C44A55"],
      ["#000000", "#0a0a0a", "#202020", "#2D2D2D", "#242424", "#C44A4A"],
    ];
    for (const [s0, s1, surface3, surface4, borderAccent, destructive] of cases) {
      const palette = composerPalette(theme(s0, s1));
      expect(palette.surface3).toBe(surface3);
      expect(palette.surface4).toBe(surface4);
      expect(palette.borderAccent).toBe(borderAccent);
      expect(palette.destructive).toBe(destructive);
      expect(palette.stop).toBe("#dc2626");
      expect(palette.error).toBe("#ef4444");
      expect(palette.stopForeground).toBe("#ffffff");
    }
  });

  it("derives extras for unknown themes", () => {
    const palette = composerPalette(theme("#111111", "#171717"));
    expect(palette.borderAccent).toBe("#333333");
    expect(palette.surface3).toBe("#333333");
    expect(palette.surface4).toBe("#88888899");
    expect(palette.destructive).toBe("#cc4444");
    expect(palette.foreground).toBe("#eeeeee");
  });
});
