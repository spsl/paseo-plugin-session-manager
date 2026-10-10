import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPEECH_SETTINGS,
  SPEECH_SETTINGS,
  blockedReason,
  pickDefaultVoice,
  shouldAnnounce,
  type SpeechSettings,
} from "./speech";

const settings = (patch: Partial<SpeechSettings> = {}): SpeechSettings => ({ ...DEFAULT_SPEECH_SETTINGS, ...patch });

describe("speech settings", () => {
  it("parses an empty document into the defaults", () => {
    expect(SPEECH_SETTINGS.schema.parse({})).toEqual(DEFAULT_SPEECH_SETTINGS);
  });
});

describe("shouldAnnounce", () => {
  it("announces every kind by default for top-level agents", () => {
    for (const kind of ["finished", "waiting", "permission", "error"] as const) {
      expect(shouldAnnounce(kind, null, settings())).toBe(true);
    }
  });

  it("respects the master switch and per-kind switches", () => {
    expect(shouldAnnounce("finished", null, settings({ enabled: false }))).toBe(false);
    expect(shouldAnnounce("finished", null, settings({ announceFinished: false }))).toBe(false);
    expect(shouldAnnounce("waiting", null, settings({ announceFinished: false }))).toBe(true);
    expect(shouldAnnounce("permission", null, settings({ announcePermission: false }))).toBe(false);
    expect(shouldAnnounce("error", null, settings({ announceError: false }))).toBe(false);
  });

  it("does not speak sub-agents unless enabled", () => {
    expect(shouldAnnounce("finished", "parent", settings())).toBe(false);
    expect(shouldAnnounce("finished", "parent", settings({ announceSubagents: true }))).toBe(true);
  });
});

describe("blockedReason", () => {
  it("is quiet when muted, disabled, or the platform switch is off", () => {
    expect(blockedReason(settings(), "desktop", false)).toBeNull();
    expect(blockedReason(settings(), "desktop", true)).toMatch(/静音/);
    expect(blockedReason(settings({ enabled: false }), "desktop", false)).toMatch(/关闭/);
    expect(blockedReason(settings({ speakOnDesktop: false }), "desktop", false)).not.toBeNull();
    expect(blockedReason(settings({ speakInBrowser: false }), "browser", false)).not.toBeNull();
    expect(blockedReason(settings(), "browser", false)).toBeNull();
    expect(blockedReason(settings(), "mobile", false)).not.toBeNull();
    expect(blockedReason(settings({ vibrateOnMobile: true }), "mobile", false)).toBeNull();
  });
});

describe("pickDefaultVoice", () => {
  it("prefers Tingting, then other zh voices, then the system default", () => {
    const voices = [
      { name: "Alex", lang: "en_US" },
      { name: "Reed (中文（中国大陆）)", lang: "zh_CN" },
      { name: "Tingting", lang: "zh_CN" },
    ];
    expect(pickDefaultVoice(voices)).toBe("Tingting");
    expect(pickDefaultVoice(voices.slice(0, 2))).toBe("Reed (中文（中国大陆）)");
    expect(pickDefaultVoice(voices.slice(0, 1))).toBe("");
    expect(pickDefaultVoice([])).toBe("");
  });
});
