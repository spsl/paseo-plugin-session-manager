import { describe, expect, it } from "vitest";
import { appearanceForSurface, parseHexColor } from "./theme-mode";

describe("parseHexColor", () => {
  it("parses #rgb, #rrggbb and #rrggbbaa", () => {
    expect(parseHexColor("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHexColor("#1a2b3c")).toEqual({ r: 26, g: 43, b: 60 });
    expect(parseHexColor("#1a2b3cff")).toEqual({ r: 26, g: 43, b: 60 });
  });
  it("rejects non-hex input", () => {
    expect(parseHexColor("rgb(1,2,3)")).toBeNull();
    expect(parseHexColor("red")).toBeNull();
    expect(parseHexColor("#12")).toBeNull();
    expect(parseHexColor("")).toBeNull();
  });
});

describe("appearanceForSurface", () => {
  it("classifies dark and light surfaces", () => {
    expect(appearanceForSurface("#0f1115")).toBe("dark");
    expect(appearanceForSurface("#000")).toBe("dark");
    expect(appearanceForSurface("#ffffff")).toBe("light");
    expect(appearanceForSurface("#f5f5f5")).toBe("light");
    expect(appearanceForSurface("#787878")).toBe("dark");
    expect(appearanceForSurface("#888888")).toBe("light");
  });
  it("defaults to dark for unparseable colors", () => {
    expect(appearanceForSurface("not a color")).toBe("dark");
  });
});
