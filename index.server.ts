import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ANALYZER_SETTINGS } from "./shared/settings";
import { SPEECH_SETTINGS } from "./shared/speech";
import { AnnouncementFeed } from "./server/announcements";
import { TimelineCardPublisher } from "./server/cards";
import { CardNotifier } from "./server/notifier";
import { SpeechSettingsCache } from "./server/speech-settings";
import { statePath } from "./server/data-dir";
import { registerHooks } from "./server/hooks";
import { registerRpcHandlers } from "./server/rpc-handlers";
import { SessionManagerService } from "./server/service";
import { SettingsCache } from "./server/settings-cache";
import { JsonStateStore } from "./server/store";

export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(ANALYZER_SETTINGS);
  const speechHandle = server.registerSettings(SPEECH_SETTINGS);
  const speechSettings = new SpeechSettingsCache(speechHandle);
  const feed = new AnnouncementFeed();
  const notifier = new CardNotifier({
    publisher: new TimelineCardPublisher(),
    feed,
    speechSettings: () => speechSettings.current(),
  });
  const store = new JsonStateStore(statePath());
  let service: SessionManagerService | null = null;
  const settings = new SettingsCache(settingsHandle, () => service?.settingsChanged());
  service = new SessionManagerService({ store, settings, notifier });
  const active = service;

  // Handlers register synchronously; restored state merges in when the load lands.
  const unregisterHooks = registerHooks(server, active);
  registerRpcHandlers(server, active, feed);
  settings.start();
  speechSettings.start();
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
    speechSettings.stop();
    active.stop();
    await store.flush();
  };
}
