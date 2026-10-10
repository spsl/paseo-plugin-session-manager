/**
 * Speech announcements: the settings document, the announcement feed event and
 * the pure rules deciding what is announced. Shared by the daemon (which
 * produces events) and the client (which speaks them). Ported from the herald
 * plugin (MIT) and reshaped around this plugin's analysis.
 *
 * Client-reachable (Hermes): no async arrows, no closures inside for...of.
 */
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const RATE_OPTIONS = ["0.8", "1", "1.2", "1.5"] as const;
export type RateOption = (typeof RATE_OPTIONS)[number];

/** `say` renders on the daemon Mac; `web` is the client's own speech synthesis. */
export const SPEECH_ENGINES = ["say", "web"] as const;
export type SpeechEngine = (typeof SPEECH_ENGINES)[number];

export const SPEECH_SETTINGS = defineSettings({
  id: "speech",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Master switch: off means nothing is spoken anywhere. */
    enabled: z.boolean().default(true),
    /** The Electron desktop app, which can speak without a click. */
    speakOnDesktop: z.boolean().default(true),
    /** A browser tab; speaks only once the page has had a user gesture (press 测试语音). */
    speakInBrowser: z.boolean().default(true),
    /** Phones: vibrate instead of speaking when no audio can be played. */
    vibrateOnMobile: z.boolean().default(false),
    engine: z.enum(SPEECH_ENGINES).default("say"),
    /** A `say` voice name; empty picks a Chinese voice (婷婷) when installed, else the system default. */
    sayVoice: z.string().default(""),
    rate: z.enum(RATE_OPTIONS).default("1"),
    announceFinished: z.boolean().default(true),
    announceWaiting: z.boolean().default(true),
    announcePermission: z.boolean().default(true),
    announceError: z.boolean().default(true),
    /** Sub-agents (with a parent) are carded but not spoken unless this is on. */
    announceSubagents: z.boolean().default(false),
  }),
});

export type SpeechSettings = z.infer<typeof SPEECH_SETTINGS.schema>;

export const DEFAULT_SPEECH_SETTINGS: SpeechSettings = {
  enabled: true,
  speakOnDesktop: true,
  speakInBrowser: true,
  vibrateOnMobile: false,
  engine: "say",
  sayVoice: "",
  rate: "1",
  announceFinished: true,
  announceWaiting: true,
  announcePermission: true,
  announceError: true,
  announceSubagents: false,
};

export const ANNOUNCEMENT_KINDS = ["finished", "waiting", "permission", "error"] as const;
export type AnnouncementKind = (typeof ANNOUNCEMENT_KINDS)[number];

export const AnnouncementSchema = z.object({
  id: z.number(),
  agentId: z.string(),
  kind: z.enum(ANNOUNCEMENT_KINDS),
  text: z.string(),
  createdAt: z.number(),
});
export type Announcement = z.infer<typeof AnnouncementSchema>;

export const SpeechVoiceSchema = z.object({ name: z.string(), lang: z.string() });
export type SpeechVoice = z.infer<typeof SpeechVoiceSchema>;

export const MAX_SPEECH_CHARS = 2000;

export function announcementKindEnabled(kind: AnnouncementKind, settings: SpeechSettings): boolean {
  switch (kind) {
    case "finished":
      return settings.announceFinished;
    case "waiting":
      return settings.announceWaiting;
    case "permission":
      return settings.announcePermission;
    case "error":
      return settings.announceError;
  }
}

/** Whether an event is announced at all: master switch, kind switch, and the sub-agent rule. */
export function shouldAnnounce(
  kind: AnnouncementKind,
  parentAgentId: string | null | undefined,
  settings: SpeechSettings,
): boolean {
  if (!settings.enabled) {
    return false;
  }
  if (parentAgentId && !settings.announceSubagents) {
    return false;
  }
  return announcementKindEnabled(kind, settings);
}

/** Why a client stays quiet for the current speech platform, or null when it may speak. */
export type SpeechPlatform = "desktop" | "browser" | "mobile";

export function blockedReason(
  settings: SpeechSettings,
  platform: SpeechPlatform,
  mutedHere: boolean,
): string | null {
  if (mutedHere) {
    return "本机已静音，请在设置中取消静音。";
  }
  if (!settings.enabled) {
    return "语音播报已在设置中关闭。";
  }
  switch (platform) {
    case "desktop":
      return settings.speakOnDesktop ? null : "桌面端播报已关闭。";
    case "browser":
      return settings.speakInBrowser ? null : "浏览器播报已关闭。";
    case "mobile":
      return settings.vibrateOnMobile ? null : "手机端未开启震动提醒。";
  }
}

/** Preferred Chinese `say` voices when the setting is empty. */
const PREFERRED_VOICE_NAMES = ["Tingting", "Ting-Ting", "婷婷", "Meijia", "美佳", "Sinji", "善怡"];

export function pickDefaultVoice(voices: readonly SpeechVoice[]): string {
  for (const wanted of PREFERRED_VOICE_NAMES) {
    for (const voice of voices) {
      if (voice.name === wanted || voice.name.indexOf(`${wanted} (`) === 0) {
        return voice.name;
      }
    }
  }
  for (const voice of voices) {
    if (voice.lang.toLowerCase().indexOf("zh") === 0) {
      return voice.name;
    }
  }
  return "";
}
