import type { PluginServerContext } from "@getpaseo/plugin/server";
import { LAUNCH_SETTINGS } from "./shared/launch";
import { ANALYZER_SETTINGS } from "./shared/settings";
import { SPEECH_SETTINGS } from "./shared/speech";
import { AnnouncementFeed } from "./server/announcements";
import { TimelineCardPublisher } from "./server/cards";
import { CardNotifier } from "./server/notifier";
import { SpeechSettingsCache } from "./server/speech-settings";
import { draftsPath, historyPath, statePath } from "./server/data-dir";
import { openDigestStore } from "./server/digest-store";
import { DraftStore } from "./server/drafts";
import { registerHooks } from "./server/hooks";
import { registerRpcHandlers } from "./server/rpc-handlers";
import { SessionManagerService } from "./server/service";
import { SettingsCache } from "./server/settings-cache";
import { JsonStateStore } from "./server/store";

export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(ANALYZER_SETTINGS);
  const speechHandle = server.registerSettings(SPEECH_SETTINGS);
  // Only the board's 新建会话 dialog reads and writes this; the server just hosts it.
  server.registerSettings(LAUNCH_SETTINGS);
  const speechSettings = new SpeechSettingsCache(speechHandle);
  const feed = new AnnouncementFeed();
  const notifier = new CardNotifier({
    publisher: new TimelineCardPublisher(),
    feed,
    speechSettings: () => speechSettings.current(),
  });
  const store = new JsonStateStore(statePath());
  const drafts = new DraftStore(draftsPath());
  const digests = openDigestStore(historyPath());
  let service: SessionManagerService | null = null;
  const settings = new SettingsCache(settingsHandle, () => service?.settingsChanged());
  service = new SessionManagerService({ store, settings, notifier, digests });
  const active = service;

  // Handlers register synchronously; restored state merges in when the load lands.
  const unregisterHooks = registerHooks(server, active);
  registerRpcHandlers(server, active, feed, drafts);
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
    // Sessions closed by the daemon's own shutdown become resumable "dormant";
    // must run before the flush so the change reaches disk.
    active.prepareShutdown();
    await Promise.all([store.flush(), drafts.flush()]);
    digests.close();
  };
}
