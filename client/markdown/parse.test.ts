import { describe, expect, it } from "vitest";
import {
  inlineToText,
  inlineUnits,
  parseInline,
  parseMarkdown,
  tableColumnUnits,
  type Block,
} from "./parse";

function first(text: string): Block {
  return parseMarkdown(text)[0];
}

describe("blocks", () => {
  it("parses headings", () => {
    expect(first("## Title ##")).toMatchObject({ type: "heading", level: 2 });
    expect(parseMarkdown("####### x")[0].type).toBe("paragraph");
  });
  it("parses paragraphs separated by blank lines and CRLF", () => {
    const blocks = parseMarkdown("a\r\nb\r\n\r\nc");
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "paragraph"]);
  });
  it("parses fenced code with language", () => {
    expect(first("```ts\nconst a = 1;\n```")).toEqual({
      type: "code",
      lang: "ts",
      text: "const a = 1;",
      closed: true,
    });
    expect(first("~~~\nx\n~~~")).toEqual({ type: "code", lang: "", text: "x", closed: true });
  });
  it("treats an unclosed fence as code to the end", () => {
    const blocks = parseMarkdown("intro\n```py\nprint(1)\n\nmore");
    expect(blocks[1]).toEqual({ type: "code", lang: "py", text: "print(1)\n\nmore", closed: false });
  });
  it("marks a bare opening fence as unclosed", () => {
    expect(first("```mermaid")).toEqual({ type: "code", lang: "mermaid", text: "", closed: false });
  });
  it("parses blockquotes with nested content", () => {
    const b = first("> # hi\n> - a\n> - b");
    expect(b.type).toBe("quote");
    if (b.type === "quote") expect(b.children.map((c) => c.type)).toEqual(["heading", "list"]);
  });
  it("parses bullet and ordered lists with start", () => {
    const b = first("3. a\n4. b");
    expect(b).toMatchObject({ type: "list", ordered: true, start: 3 });
    if (b.type === "list") expect(b.items).toHaveLength(2);
    const u = first("- a\n- b\n\n- c");
    if (u.type === "list") expect(u.items).toHaveLength(3);
  });
  it("parses nested lists and code inside lists", () => {
    const b = first("- a\n  - b\n  - c\n- d\n  ```js\n  x()\n  ```");
    expect(b.type).toBe("list");
    if (b.type === "list") {
      expect(b.items).toHaveLength(2);
      expect(b.items[0].children.map((c) => c.type)).toEqual(["paragraph", "list"]);
      expect(b.items[1].children[1]).toEqual({ type: "code", lang: "js", text: "x()", closed: true });
    }
  });
  it("parses list in blockquote", () => {
    const b = first("> 1. one\n> 2. two");
    if (b.type === "quote") expect(b.children[0]).toMatchObject({ type: "list", ordered: true });
    else throw new Error("not quote");
  });
  it("parses task items", () => {
    const b = first("- [ ] todo\n- [x] done");
    if (b.type === "list") expect(b.items.map((i) => i.checked)).toEqual([false, true]);
    else throw new Error("not list");
  });
  it("parses tables with alignment", () => {
    const b = first("| a | b | c |\n|:--|:-:|--:|\n| 1 | 2 | 3 |\n| x | y |");
    if (b.type !== "table") throw new Error("not table");
    expect(b.align).toEqual(["left", "center", "right"]);
    expect(b.rows).toHaveLength(2);
    expect(inlineToText(b.header[0])).toBe("a");
    expect(b.rows[1][2]).toEqual([]);
  });
  it("sizes table columns by the widest cell in each column", () => {
    const b = first("| a | 长列标题 |\n|---|---|\n| x | y |\n| wwwwwwwwww | z |");
    if (b.type !== "table") throw new Error("not table");
    const units = tableColumnUnits(b.header, b.rows);
    expect(units).toHaveLength(2);
    expect(units[0]).toBeCloseTo(10 * 0.55, 5);
    expect(units[1]).toBeCloseTo(4 * 1.08, 5);
    expect(tableColumnUnits([], [])).toEqual([]);
  });
  it("estimates CJK text wider than ASCII", () => {
    expect(inlineUnits(parseInline("汉字"))).toBeCloseTo(2, 5);
    expect(inlineUnits(parseInline("ab"))).toBeCloseTo(1.1, 5);
  });
  it("parses thematic breaks", () => {
    expect(parseMarkdown("---\n***\n___").map((b) => b.type)).toEqual(["hr", "hr", "hr"]);
  });
  it("keeps html as text", () => {
    const b = first("<div>hi</div>");
    expect(b.type === "paragraph" ? inlineToText(b.inline) : "").toBe("<div>hi</div>");
  });
  it("list interrupts paragraph", () => {
    expect(parseMarkdown("intro\n- a").map((b) => b.type)).toEqual(["paragraph", "list"]);
  });
});

describe("inline", () => {
  it("bold, italic, strike, code", () => {
    expect(parseInline("**b** __b__")).toEqual([
      { t: "bold", children: [{ t: "text", text: "b" }] },
      { t: "text", text: " " },
      { t: "bold", children: [{ t: "text", text: "b" }] },
    ]);
    expect(parseInline("*i* _i_").filter((n) => n.t === "italic")).toHaveLength(2);
    expect(parseInline("~~s~~")[0].t).toBe("strike");
    expect(parseInline("`a*b`")).toEqual([{ t: "code", text: "a*b" }]);
    expect(parseInline("``a`b``")).toEqual([{ t: "code", text: "a`b" }]);
  });
  it("bold+italic", () => {
    expect(parseInline("***x***")[0]).toMatchObject({ t: "bold", children: [{ t: "italic" }] });
  });
  it("does not italicize snake_case", () => {
    expect(parseInline("some_snake_case_word")).toEqual([{ t: "text", text: "some_snake_case_word" }]);
  });
  it("does not treat spaced stars as emphasis", () => {
    expect(inlineToText(parseInline("2 * 3 * 4"))).toBe("2 * 3 * 4");
    expect(parseInline("2 * 3 * 4").every((n) => n.t === "text")).toBe(true);
  });
  it("renders unclosed markers literally", () => {
    expect(parseInline("**oops")).toEqual([{ t: "text", text: "**oops" }]);
    expect(parseInline("`oops")).toEqual([{ t: "text", text: "`oops" }]);
    expect(inlineToText(parseInline("[a](http://x"))).toBe("[a](http://x");
  });
  it("links, autolinks and bare urls", () => {
    expect(parseInline("[t](https://a.com/x)")).toEqual([
      { t: "link", url: "https://a.com/x", children: [{ t: "text", text: "t" }] },
    ]);
    expect(parseInline("<https://a.com>")[0]).toMatchObject({ t: "link", url: "https://a.com" });
    const bare = parseInline("see https://a.com/p?q=1, ok");
    expect(bare[1]).toMatchObject({ t: "link", url: "https://a.com/p?q=1" });
    expect(inlineToText(bare)).toBe("see https://a.com/p?q=1, ok");
    expect(parseInline("(https://a.com/x_(y))")[1]).toMatchObject({ url: "https://a.com/x_(y)" });
    expect(parseInline("链接https://a.com。好")[1]).toMatchObject({ url: "https://a.com" });
  });
  it("hard breaks", () => {
    expect(parseInline("a  \nb").map((n) => n.t)).toEqual(["text", "br", "text"]);
    expect(parseInline("a\\\nb").map((n) => n.t)).toEqual(["text", "br", "text"]);
  });
  it("backslash escapes", () => {
    expect(parseInline("\\*not\\* \\`x")).toEqual([{ t: "text", text: "*not* `x" }]);
  });
  it("CJK adjacent to bold", () => {
    expect(parseInline("这是**粗体**文字")).toEqual([
      { t: "text", text: "这是" },
      { t: "bold", children: [{ t: "text", text: "粗体" }] },
      { t: "text", text: "文字" },
    ]);
  });
});

describe("robustness", () => {
  it("parses 50k chars quickly", () => {
    const chunk = "这是 **粗体** 和 `code` 与 [x](https://a.com) *a\n- item _x\n";
    const text = chunk.repeat(Math.ceil(50000 / chunk.length));
    const t = performance.now();
    parseMarkdown(text);
    expect(performance.now() - t).toBeLessThan(200);
  });
  it("pathological unclosed markers stay fast", () => {
    const t = performance.now();
    parseMarkdown("*a ".repeat(15000) + "\n" + "[".repeat(5000) + "`".repeat(3000));
    expect(performance.now() - t).toBeLessThan(500);
  });
  it("never throws", () => {
    for (const s of ["", "|", "|\n|-", "> ", "- ", "1.", "```", "[](", "<", "\\", "*", "~~", "- [ ]", "#"]) {
      expect(() => parseMarkdown(s)).not.toThrow();
    }
  });
});
