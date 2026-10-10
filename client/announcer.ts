/**
 * The part that runs while the app is open, whether or not any screen is on
 * display: `index.client.tsx` starts one per connected client and stops it on
 * cleanup (a screen would not do: it unmounts the moment the user navigates).
 *
 * It pulls, because a plugin has no server-to-client push: a short poll of the
 * announcements feed. Each event is spoken once per device (deduped by id), and
 * events present when this client started are skipped. Ported from herald (MIT).
 *
 * Async **function expressions** only, never async arrows (Hermes).
 */
import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { announcementsRpc, speechRenderRpc } from "../shared/rpc";
import {
  blockedReason,
  DEFAULT_SPEECH_SETTINGS,
  SPEECH_SETTINGS,
  type SpeechSettings,
} from "../shared/speech";
import { nextDelay, pickFresh } from "./announce-logic";
import {
  canSpeak,
  primeSpeech,
  speakWeb,
  speechPlatform,
  stopSpeaking,
  vibrate,
} from "./web-speech";

function swallow(): undefined {
  return undefined;
}

let mirrored: SpeechSettings | null = null;

/** The settings as last read by anything (the announcer or a mounted settings screen). */
export function mirrorSettings(values: SpeechSettings): void {
  mirrored = values;
}

/** Muted on this device only, until restart: module scope, not a shared setting. */
let mutedHere = false;

export function isMutedHere(): boolean {
  return mutedHere;
}

export function setMutedHere(muted: boolean): void {
  mutedHere = muted;
}

export interface Announcer {
  stop(): void;
  poke(): void;
  /**
   * Speak `text` now. Resolves to null once spoken, or to the reason this
   * device stayed quiet. `force` skips the switches (测试语音 only; on the web
   * it is also the press that hands the browser its audio permission).
   */
  speakText(text: string, options?: { force?: boolean }): Promise<string | null>;
}

let active: Announcer | null = null;

/** The running announcer, for card and settings buttons. Null before the client entry has run. */
export function getAnnouncer(): Announcer | null {
  return active;
}

export function startAnnouncer(client: PluginClientContext): Announcer {
  let stopped = false;
  let polling = false;
  let seeding = true;
  let since = 0;
  let failures = 0;
  let warnedSettings = false;
  let warnedSay = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const seen = new Set<number>();
  /** Deliveries queue behind one another, so a button press never talks over the poll. */
  let chain: Promise<void> = Promise.resolve();

  async function readSettings(): Promise<SpeechSettings> {
    try {
      const result = await client.rpc(settingsRpc(SPEECH_SETTINGS.id).read, {});
      if (result.status === "ready") {
        const parsed = SPEECH_SETTINGS.schema.safeParse(result.values);
        if (parsed.success) {
          mirrored = parsed.data;
          return parsed.data;
        }
      }
    } catch (error) {
      if (!warnedSettings) {
        warnedSettings = true;
        console.warn("[session-manager] 无法读取语音设置，沿用上次的值", error);
      }
    }
    return mirrored ?? DEFAULT_SPEECH_SETTINGS;
  }

  /**
   * The daemon Mac's voice when asked for and reachable, otherwise the browser
   * voice. A failed render or refused playback falls through rather than to
   * silence, and is logged once.
   */
  async function deliverNow(text: string, settings: SpeechSettings): Promise<void> {
    if (stopped) {
      return;
    }
    const platform = speechPlatform();
    const rate = Number(settings.rate);
    if (settings.engine === "say") {
      try {
        const audio = await client.rpc(speechRenderRpc, { text, voice: settings.sayVoice, rate });
        if (stopped) {
          return;
        }
        await client.playAudio({ base64: audio.base64, mimeType: audio.mimeType });
        return;
      } catch (error) {
        if (!warnedSay) {
          warnedSay = true;
          console.warn("[session-manager] 守护进程的 say 语音不可用，改用浏览器语音", error);
        }
      }
    }
    if (platform === "mobile") {
      vibrate();
      return;
    }
    if (canSpeak()) {
      await speakWeb(text, "", rate);
    }
  }

  function deliver(text: string, settings: SpeechSettings): Promise<void> {
    const next = chain.then(
      function run() {
        return deliverNow(text, settings);
      },
      function runAfterFailure() {
        return deliverNow(text, settings);
      },
    );
    chain = next.catch(swallow);
    return next;
  }

  function schedule(delay: number): void {
    if (stopped) {
      return;
    }
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(function tick() {
      void poll();
    }, delay);
  }

  async function poll(): Promise<void> {
    if (stopped || polling) {
      return;
    }
    polling = true;
    try {
      const result = await client.rpc(announcementsRpc, { since });
      if (stopped) {
        return;
      }
      failures = 0;
      const picked = pickFresh(result.events, result.cursor, since, seen, seeding);
      seeding = false;
      since = picked.since;
      if (picked.fresh.length > 0) {
        const settings = await readSettings();
        for (const event of picked.fresh) {
          if (blockedReason(settings, speechPlatform(), mutedHere) === null) {
            // Delivery failures are swallowed: one bad sentence must not stop the rest.
            await deliver(event.text, settings).catch(swallow);
          }
        }
      }
    } catch (error) {
      failures += 1;
      if (failures === 1) {
        console.warn("[session-manager] 无法获取语音播报列表", error);
      }
    } finally {
      polling = false;
      schedule(nextDelay(failures));
    }
  }

  const announcer: Announcer = {
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      // A reload starts the replacement at once; whatever this one says must stop.
      stopSpeaking();
      if (active === announcer) {
        active = null;
      }
    },
    poke() {
      schedule(0);
    },
    /** `primeSpeech()` goes first: it must run in the press handler's own task, before any await. */
    async speakText(text, options) {
      primeSpeech();
      const settings = await readSettings();
      const blocked =
        options?.force === true ? null : blockedReason(settings, speechPlatform(), mutedHere);
      if (blocked !== null) {
        return blocked;
      }
      await deliver(text, settings);
      return null;
    },
  };
  active = announcer;
  schedule(500);
  return announcer;
}
