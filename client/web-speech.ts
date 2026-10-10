/**
 * Every browser speech global this plugin touches, in one guarded module (the
 * rest of client/ typechecks without the DOM library). Gated on Platform.OS
 * and degrading to no-ops on iOS/Android. Fallback voice only: the preferred
 * voice is the daemon Mac's `say`, played through `client.playAudio`.
 * Ported from the herald plugin (MIT).
 */
import { Platform, Vibration } from "react-native";
import type { SpeechPlatform } from "../shared/speech";
import { isDesktop } from "./desktop-bridge";

interface WebVoice {
  readonly name: string;
  readonly lang: string;
}

interface WebUtterance {
  text: string;
  rate: number;
  volume: number;
  voice: WebVoice | null;
  onend: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
}

interface WebSynth {
  speak(utterance: WebUtterance): void;
  cancel(): void;
  getVoices(): WebVoice[];
  readonly speaking: boolean;
}

interface WebGlobals {
  speechSynthesis?: WebSynth;
  SpeechSynthesisUtterance?: new (text: string) => WebUtterance;
}

function web(): WebGlobals | null {
  return Platform.OS === "web" ? (globalThis as WebGlobals) : null;
}

export function speechPlatform(): SpeechPlatform {
  if (Platform.OS !== "web") {
    return "mobile";
  }
  return isDesktop() ? "desktop" : "browser";
}

export function canSpeak(): boolean {
  const globals = web();
  return (
    globals !== null &&
    typeof globals.speechSynthesis?.speak === "function" &&
    typeof globals.SpeechSynthesisUtterance === "function"
  );
}

export type WebSpeechVoice = { name: string; lang: string };

export function listWebVoices(): WebSpeechVoice[] {
  const synth = web()?.speechSynthesis;
  if (synth === undefined) {
    return [];
  }
  return synth
    .getVoices()
    .map(function toVoice(voice) {
      return { name: voice.name, lang: voice.lang };
    })
    .sort(function byLang(a, b) {
      return a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name);
    });
}

/** Chromium collects an utterance nothing references before it ends; holding it here is the workaround. */
const inFlight = new Set<WebUtterance>();

/**
 * Resolves when the utterance ends, or after a guard time (a browser that drops
 * the call for lack of user activation fires nothing). Rejects when there is no
 * speech synthesis here.
 */
export function speakWeb(text: string, voiceName: string, rate: number): Promise<void> {
  const globals = web();
  const synth = globals?.speechSynthesis;
  const Utterance = globals?.SpeechSynthesisUtterance;
  if (synth === undefined || Utterance === undefined || !canSpeak()) {
    return Promise.reject(new Error("此设备不支持浏览器语音合成"));
  }
  return new Promise<void>(function executor(resolve) {
    const utterance = new Utterance(text);
    utterance.rate = rate;
    const voices = synth.getVoices();
    const match = voices.find(function pick(voice) {
      return voiceName !== "" ? voice.name === voiceName : voice.lang.toLowerCase().indexOf("zh") === 0;
    });
    if (match !== undefined) {
      utterance.voice = match;
    }
    let settled = false;
    function finish(): void {
      if (settled) {
        return;
      }
      settled = true;
      inFlight.delete(utterance);
      resolve();
    }
    utterance.onend = finish;
    utterance.onerror = finish;
    inFlight.add(utterance);
    setTimeout(finish, Math.max(8_000, text.length * 300));
    synth.speak(utterance);
  });
}

export function stopSpeaking(): void {
  web()?.speechSynthesis?.cancel();
}

/**
 * Takes the user activation a browser grants for speech, in the press
 * handler's own task: speaks an inaudible utterance before any await.
 */
export function primeSpeech(): void {
  const globals = web();
  if (globals === null) {
    return;
  }
  const synth = globals.speechSynthesis;
  const Utterance = globals.SpeechSynthesisUtterance;
  if (synth !== undefined && Utterance !== undefined && !synth.speaking) {
    const silent = new Utterance(" ");
    silent.volume = 0;
    synth.speak(silent);
  }
}

/** The most a phone can do without audio. A no-op on web. */
export function vibrate(): void {
  if (Platform.OS !== "web") {
    Vibration.vibrate();
  }
}
