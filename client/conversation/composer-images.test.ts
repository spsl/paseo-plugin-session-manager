import { describe, expect, it } from "vitest";
import { imagesOption, parseImageDataUrl, toSendImages, type ComposerImage } from "./composer-images";

describe("parseImageDataUrl", () => {
  it("parses a normal image data url", () => {
    expect(parseImageDataUrl("data:image/png;base64,AAA")).toEqual({
      mimeType: "image/png",
      data: "AAA",
    });
  });

  it("splits at the first comma only", () => {
    expect(parseImageDataUrl("data:image/png;base64,AA,A,,")).toEqual({
      mimeType: "image/png",
      data: "AA,A,,",
    });
  });

  it("rejects non-image, missing base64, missing data: and empty payload", () => {
    expect(parseImageDataUrl("data:text/plain;base64,AAA")).toBeNull();
    expect(parseImageDataUrl("data:image/png,AAA")).toBeNull();
    expect(parseImageDataUrl("image/png;base64,AAA")).toBeNull();
    expect(parseImageDataUrl("data:image/png;base64,")).toBeNull();
    expect(parseImageDataUrl("")).toBeNull();
  });
});

describe("toSendImages", () => {
  it("strips id and uri and returns a fresh array", () => {
    const input: ComposerImage[] = [
      { id: "i1", mimeType: "image/png", data: "AAA", uri: "data:image/png;base64,AAA" },
      { id: "i2", mimeType: "image/jpeg", data: "BBB", uri: "data:image/jpeg;base64,BBB" },
    ];
    const out = toSendImages(input);
    expect(out).toEqual([
      { data: "AAA", mimeType: "image/png" },
      { data: "BBB", mimeType: "image/jpeg" },
    ]);
    expect(out).not.toBe(input);
    out[0].data = "mutated";
    expect(input[0].data).toBe("AAA");
  });
});

describe("imagesOption", () => {
  it("returns {} without images and {images} otherwise", () => {
    expect(imagesOption([])).toEqual({});
    expect(
      imagesOption([{ id: "i1", mimeType: "image/png", data: "AAA", uri: "u" }]),
    ).toEqual({ images: [{ data: "AAA", mimeType: "image/png" }] });
  });
});
