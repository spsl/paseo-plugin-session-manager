/** Theme-derived tones and small style helpers shared by the board UI. */
import type { PluginTheme } from "@getpaseo/plugin";
import type { AnalysisStatus, BoardColumn } from "../shared/types";

export function withAlpha(color: string, alpha: string, fallback: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? `${color}${alpha}` : fallback;
}

export function columnTone(theme: PluginTheme, column: BoardColumn): string {
  const { colors } = theme;
  switch (column) {
    case "waiting_for_user":
      return colors.statusWarning;
    case "in_progress":
      return colors.accent;
    case "completed":
      return colors.statusSuccess;
    case "unclear":
    case "closed":
      return colors.foregroundMuted;
  }
}

export function statusTone(theme: PluginTheme, status: AnalysisStatus): string {
  switch (status) {
    case "waiting_for_user":
    case "blocked":
      return theme.colors.statusWarning;
    case "in_progress":
      return theme.colors.accent;
    case "completed":
      return theme.colors.statusSuccess;
    case "unclear":
      return theme.colors.foregroundMuted;
  }
}

export function toneBackground(theme: PluginTheme, tone: string): string {
  return withAlpha(tone, "26", theme.colors.surface2);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
