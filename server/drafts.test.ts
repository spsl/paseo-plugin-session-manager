import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DraftStore, MAX_DRAFT_CHARS } from "./drafts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "sm-drafts-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function store(): DraftStore {
  return new DraftStore(join(dir, "drafts.json"));
}

describe("DraftStore", () => {
  it("round-trips drafts across instances", async () => {
    const first = store();
    await first.load();
    first.set("a", "未发送的草稿");
    first.set("b", "");
    await first.flush();

    const second = store();
    await second.load();
    expect(second.get("a")).toBe("未发送的草稿");
    expect(second.get("b")).toBeNull();
    expect(second.get("missing")).toBeNull();
  });

  it("clears a draft on blank input and caps length", async () => {
    const s = store();
    await s.load();
    s.set("a", "x".repeat(MAX_DRAFT_CHARS + 10));
    expect(s.get("a")).toHaveLength(MAX_DRAFT_CHARS);
    s.set("a", "   ");
    expect(s.get("a")).toBeNull();
  });

  it("a flush without changes leaves saved drafts alone, even if never loaded", async () => {
    const first = store();
    await first.load();
    first.set("a", "保留的草稿");
    await first.flush();

    const idle = store();
    await idle.flush();

    const third = store();
    await third.load();
    expect(third.get("a")).toBe("保留的草稿");
  });

  it("starts empty when the file is missing or malformed", async () => {
    const s = store();
    await s.load();
    expect(s.get("a")).toBeNull();
  });
});
