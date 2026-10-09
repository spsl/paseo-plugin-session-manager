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
