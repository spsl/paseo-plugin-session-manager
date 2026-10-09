import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ANALYZER_SETTINGS } from "./shared/settings";
import { statePath } from "./server/data-dir";
import { registerHooks } from "./server/hooks";
import { registerRpcHandlers } from "./server/rpc-handlers";
import { SessionManagerService } from "./server/service";
import { SettingsCache } from "./server/settings-cache";
import { JsonStateStore } from "./server/store";

export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(ANALYZER_SETTINGS);
  const store = new JsonStateStore(statePath());
  let service: SessionManagerService | null = null;
  const settings = new SettingsCache(settingsHandle, () => service?.settingsChanged());
  service = new SessionManagerService({ store, settings });
  const active = service;

  // Handlers register synchronously; restored state merges in when the load lands.
  const unregisterHooks = registerHooks(server, active);
  registerRpcHandlers(server, active);
  settings.start();
  void active
    .load()
    .then((count) => {
      console.log(`[session-manager] started, ${count} sessions restored`);
    })
    .catch((error: unknown) => {
      console.error("[session-manager] could not restore state", error);
    });

  return async () => {
    unregisterHooks();
    settings.stop();
    active.stop();
    await store.flush();
  };
}
