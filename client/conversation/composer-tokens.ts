/**
 * Colors the Paseo composer uses that PluginTheme does not expose. The built-in
 * host palettes are looked up by the theme's surface0|surface1 pair (they map
 * 1:1 to PluginTheme); unknown themes fall back to derived colors.
 * Pure TS, no async arrows (Hermes).
 */
import type { PluginTheme } from "@getpaseo/plugin";
import { withAlpha } from "../styles";

export type ComposerPalette = {
  surface0: string;
  surface1: string;
  surface2: string;
  surface3: string;
  surface4: string;
  border: string;
  borderAccent: string;
  foreground: string;
  foregroundMuted: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  /** Paseo stop button red (#dc2626), error text (#ef4444) and its icon white. */
  stop: string;
  error: string;
  stopForeground: string;
  /** Paseo context-ring warning band: palette.amber[500], theme-independent. */
  amber: string;
};

type PaletteExtras = Pick<
  ComposerPalette,
  "surface3" | "surface4" | "borderAccent" | "destructive"
>;

/** Paseo 0.11.2 built-in palettes, keyed by `surface0|surface1` (lowercase). */
const PALETTES: Record<string, PaletteExtras> = {
  "#ffffff|#fafafa": {
    surface3: "#E4E4E7",
    surface4: "#D4D4D8",
    borderAccent: "#ECECF1",
    destructive: "#B04138",
  },
  "#181b1a|#1e2120": {
    surface3: "#434645",
    surface4: "#595B5B",
    borderAccent: "#2F3534",
    destructive: "#C64F43",
  },
  "#18181b|#1f1f22": {
    surface3: "#3F3F46",
    surface4: "#52525B",
    borderAccent: "#303036",
    destructive: "#C44A4A",
  },
  "#161820|#1c1e27": {
    surface3: "#3C3E4C",
    surface4: "#535564",
    borderAccent: "#2E3040",
    destructive: "#C44A52",
  },
  "#1f1f1e|#262523": {
    surface3: "#4A4745",
    surface4: "#605D5B",
    borderAccent: "#36332F",
    destructive: "#CF513E",
  },
  "#282c34|#2f333d": {
    surface3: "#4A4F5E",
    surface4: "#5B6175",
    borderAccent: "#3F4454",
    destructive: "#C44A55",
  },
  "#000000|#0a0a0a": {
    surface3: "#202020",
    surface4: "#2D2D2D",
    borderAccent: "#242424",
    destructive: "#C44A4A",
  },
};

export function composerPalette(theme: PluginTheme): ComposerPalette {
  const { colors } = theme;
  const key = `${colors.surface0.toLowerCase()}|${colors.surface1.toLowerCase()}`;
  const known = PALETTES[key];
  const extras: PaletteExtras = known ?? {
    surface3: colors.border,
    surface4: withAlpha(colors.foregroundMuted, "99", colors.foregroundMuted),
    borderAccent: colors.border,
    destructive: colors.statusDanger,
  };
  return {
    surface0: colors.surface0,
    surface1: colors.surface1,
    surface2: colors.surface2,
    surface3: extras.surface3,
    surface4: extras.surface4,
    border: colors.border,
    borderAccent: extras.borderAccent,
    foreground: colors.foreground,
    foregroundMuted: colors.foregroundMuted,
    accent: colors.accent,
    accentForeground: colors.accentForeground,
    destructive: extras.destructive,
    stop: "#dc2626",
    error: "#ef4444",
    stopForeground: "#ffffff",
    amber: "#f59e0b",
  };
}

/** Paseo context ring: >90% destructive, >=70% amber[500], else foregroundMuted. */
export function contextColor(palette: ComposerPalette, pct: number): string {
  if (pct > 90) {
    return palette.destructive;
  }
  if (pct >= 70) {
    return palette.amber;
  }
  return palette.foregroundMuted;
}
