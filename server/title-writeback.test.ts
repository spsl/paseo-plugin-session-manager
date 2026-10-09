import { describe, expect, it } from "vitest";
import { decideTitleWrite, isAutoTitle } from "./title-writeback";

const state = { lastWritten: null as string | null };
const base = {
  enabled: true,
  live: true,
  userOwned: false,
  currentTitle: null as string | null,
  generatedTitle: "新标题",
  titleState: state,
  firstUserMessage: "帮我重构登录模块并补充测试用例",
};

describe("isAutoTitle", () => {
  it("accepts empty, last-written, and truncated first-prompt titles", () => {
    expect(isAutoTitle(null, state, null)).toBe(true);
    expect(isAutoTitle("  ", state, null)).toBe(true);
    expect(isAutoTitle("上次写入", { lastWritten: "上次写入" }, null)).toBe(true);
    expect(isAutoTitle("帮我重构登录模块…", state, base.firstUserMessage)).toBe(true);
    expect(isAutoTitle("帮我重构登录模块...", state, base.firstUserMessage)).toBe(true);
    expect(isAutoTitle("帮我重构登录模块并补充测试用例", state, base.firstUserMessage)).toBe(true);
  });

  it("rejects user-chosen titles", () => {
    expect(isAutoTitle("我的名字", state, base.firstUserMessage)).toBe(false);
    expect(isAutoTitle("我的名字", state, null)).toBe(false);
  });
});

describe("decideTitleWrite", () => {
  it("skips when disabled, not live, or user owned", () => {
    expect(decideTitleWrite({ ...base, enabled: false })).toBe("skip");
    expect(decideTitleWrite({ ...base, live: false })).toBe("skip");
    expect(decideTitleWrite({ ...base, userOwned: true })).toBe("skip");
  });

  it("skips when the title already matches", () => {
    expect(decideTitleWrite({ ...base, currentTitle: "新标题" })).toBe("skip");
  });

  it("marks user ownership for non-automatic titles", () => {
    expect(decideTitleWrite({ ...base, currentTitle: "我的名字" })).toBe("mark_user_owned");
  });

  it("writes over automatic titles", () => {
    expect(decideTitleWrite(base)).toBe("write");
    expect(decideTitleWrite({ ...base, currentTitle: "旧生成", titleState: { lastWritten: "旧生成" } })).toBe("write");
  });
});
