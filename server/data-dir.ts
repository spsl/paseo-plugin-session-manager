import { homedir } from "node:os";
import { join } from "node:path";

export const PLUGIN_ID = "session-manager";

export function paseoHome(): string {
  const home = process.env.PASEO_HOME?.trim();
  return home ? home : join(homedir(), ".paseo");
}

/** `$PASEO_HOME/plugin-data/session-manager/`; Paseo never touches plugin-data. */
export function pluginDir(): string {
  return join(paseoHome(), "plugin-data", PLUGIN_ID);
}

export function statePath(): string {
  return join(pluginDir(), "state.json");
}

export function draftsPath(): string {
  return join(pluginDir(), "drafts.json");
}

/** Per-turn digests (history.db) live next to state.json. */
export function historyPath(): string {
  return join(pluginDir(), "history.db");
}
