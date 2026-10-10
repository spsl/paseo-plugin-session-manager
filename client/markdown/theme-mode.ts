/**
 * PluginTheme exposes colors but no appearance flag, so dark vs light is
 * inferred from the surface color's luminance for mermaid's theme pick.
 */

/** Parses #rgb / #rrggbb / #rrggbbaa; returns null for anything else. */
export function parseHexColor(color: string): { r: number; g: number; b: number } | null {
  const match = /^#([0-9a-fA-F]{3,8})$/.exec(color.trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3 || hex.length === 4) {
    let expanded = "";
    for (let i = 0; i < hex.length; i++) expanded += hex[i] + hex[i];
    hex = expanded;
  }
  if (hex.length !== 6 && hex.length !== 8) return null;
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/** "dark" when the surface's relative luminance is under 0.5; unparseable → "dark". */
export function appearanceForSurface(color: string): "light" | "dark" {
  const rgb = parseHexColor(color);
  if (rgb === null) return "dark";
  const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return luminance < 0.5 ? "dark" : "light";
}
