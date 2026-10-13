/**
 * Reads Paseo's own "default send" setting so the plugin composer behaves like
 * the host composer. Paseo stores app settings as a flat JSON object under the
 * `@paseo:app-settings` AsyncStorage key; on web AsyncStorage is
 * window.localStorage. Read-only and re-read on every submit; anything missing
 * or malformed falls back to "steer", which is also Paseo's default.
 * Structured globals like desktop-bridge.ts (no DOM lib in this project).
 */
import type { SendBehavior } from "./conversation/composer-logic";

export const PASEO_APP_SETTINGS_KEY = "@paseo:app-settings";

type StorageLike = { getItem(key: string): string | null };

interface StorageGlobal {
  window?: { localStorage?: StorageLike };
}

function defaultStorage(): StorageLike | null {
  try {
    return (globalThis as unknown as StorageGlobal).window?.localStorage ?? null;
  } catch {
    return null;
  }
}

function isSendBehavior(value: unknown): value is SendBehavior {
  return value === "interrupt" || value === "steer" || value === "queue";
}

export function readPaseoSendBehavior(storage?: StorageLike | null): SendBehavior {
  const store = storage === undefined ? defaultStorage() : storage;
  if (store === null) {
    return "steer";
  }
  try {
    const raw = store.getItem(PASEO_APP_SETTINGS_KEY);
    if (raw === null) {
      return "steer";
    }
    const parsed: unknown = JSON.parse(raw);
    const value =
      typeof parsed === "object" && parsed !== null
        ? (parsed as { sendBehavior?: unknown }).sendBehavior
        : undefined;
    return isSendBehavior(value) ? value : "steer";
  } catch {
    return "steer";
  }
}
