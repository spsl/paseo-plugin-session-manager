import { describe, expect, it } from "vitest";
import { PASEO_APP_SETTINGS_KEY, readPaseoSendBehavior } from "./paseo-app-settings";

function storageOf(raw: string | null): { getItem(key: string): string | null } {
  return {
    getItem(key: string) {
      return key === PASEO_APP_SETTINGS_KEY ? raw : null;
    },
  };
}

describe("readPaseoSendBehavior", () => {
  it("reads a stored behavior", () => {
    expect(readPaseoSendBehavior(storageOf('{"sendBehavior":"queue"}'))).toBe("queue");
    expect(readPaseoSendBehavior(storageOf('{"sendBehavior":"interrupt"}'))).toBe("interrupt");
    expect(readPaseoSendBehavior(storageOf('{"sendBehavior":"steer"}'))).toBe("steer");
  });

  it("falls back to steer for missing key, bad json, illegal value, null storage", () => {
    expect(readPaseoSendBehavior(storageOf(null))).toBe("steer");
    expect(readPaseoSendBehavior(storageOf("{oops"))).toBe("steer");
    expect(readPaseoSendBehavior(storageOf('{"sendBehavior":"bogus"}'))).toBe("steer");
    expect(readPaseoSendBehavior(storageOf('"queue"'))).toBe("steer");
    expect(readPaseoSendBehavior(storageOf("null"))).toBe("steer");
    expect(readPaseoSendBehavior(null)).toBe("steer");
    expect(readPaseoSendBehavior()).toBe("steer");
  });
});
