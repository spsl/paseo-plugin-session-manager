import { describe, expect, it } from "vitest";
import { listSayVoices, parseVoiceList, renderWithSay, sayArguments, sayAvailable, speakable } from "./say";

describe("say arguments", () => {
  it("renders to a WAV file reading stdin", () => {
    expect(sayArguments({ voice: "", rate: 1 }, "/tmp/x.wav")).toEqual([
      "-o",
      "/tmp/x.wav",
      "--file-format=WAVE",
      "--data-format=LEI16@16000",
      "-f",
      "-",
    ]);
  });

  it("adds voice and a words-per-minute rate", () => {
    const args = sayArguments({ voice: " Tingting ", rate: 1.2 }, "/tmp/x.wav");
    expect(args.slice(-4)).toEqual(["-v", "Tingting", "-r", "210"]);
  });

  it("strips embedded speech commands and collapses whitespace", () => {
    expect(speakable("你好 [[volm 0.1]]\n\n世界")).toBe("你好 volm 0.1 世界");
  });
});

describe("parseVoiceList", () => {
  it("parses names with spaces and parentheses, and locales", () => {
    const output = [
      "Tingting            zh_CN    # 你好！我叫婷婷。",
      "Reed (中文（中国大陆）)     zh_CN    # 你好！我叫Reed。",
      "Alex                en_US    # Hello",
      "garbage line",
    ].join("\n");
    expect(parseVoiceList(output)).toEqual([
      { name: "Tingting", lang: "zh_CN" },
      { name: "Reed (中文（中国大陆）)", lang: "zh_CN" },
      { name: "Alex", lang: "en_US" },
    ]);
  });
});

describe.runIf(process.platform === "darwin")("say on this Mac", () => {
  it("lists voices and renders a Chinese sentence to WAV audio", async () => {
    expect(await sayAvailable()).toBe(true);
    const voices = await listSayVoices();
    expect(voices.length).toBeGreaterThan(0);
    const audio = await renderWithSay("会话看板：测试语音。", { voice: "", rate: 1 });
    expect(audio.mimeType).toBe("audio/wav");
    const bytes = Buffer.from(audio.base64, "base64");
    expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(bytes.length).toBeGreaterThan(2000);
  }, 40_000);
});
