/** Small self-contained Markdown parser (block + inline AST). Pure TS; never throws. */

export type Inline =
  | { t: "text"; text: string }
  | { t: "bold"; children: Inline[] }
  | { t: "italic"; children: Inline[] }
  | { t: "strike"; children: Inline[] }
  | { t: "code"; text: string }
  | { t: "link"; url: string; children: Inline[] }
  | { t: "br" };

export type Align = "left" | "right" | "center" | null;

export interface ListItem {
  checked: boolean | null;
  children: Block[];
}

export type Block =
  | { type: "heading"; level: number; inline: Inline[] }
  | { type: "paragraph"; inline: Inline[] }
  | { type: "code"; lang: string; text: string; closed: boolean }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { type: "hr" };

const MAX_DEPTH = 8;

// ---------------------------------------------------------------- inline

function isAlnum(code: number): boolean {
  return (
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
  );
}

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || ch === "" || /\s/.test(ch);
}

function isEscapable(ch: string): boolean {
  return "\\`*_{}[]()#+-.!~|<>\"'&$%^=:;,?/@".indexOf(ch) >= 0;
}

function pushText(out: Inline[], text: string): void {
  if (text === "") return;
  const last = out[out.length - 1];
  if (last && last.t === "text") last.text += text;
  else out.push({ t: "text", text });
}

/** Index just after the run of `ch` starting at `from`. */
function runEnd(s: string, from: number, ch: string): number {
  let j = from;
  while (j < s.length && s[j] === ch) j++;
  return j;
}

function findCodeClose(s: string, from: number, n: number): number {
  let j = from;
  while (j < s.length) {
    if (s[j] !== "`") {
      j++;
      continue;
    }
    const end = runEnd(s, j, "`");
    if (end - j === n) return j;
    j = end;
  }
  return -1;
}

function findClosingBracket(s: string, open: number): number {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const ch = s[j];
    if (ch === "\\") j++;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return j;
    } else if (ch === "\n" && s[j + 1] === "\n") return -1;
  }
  return -1;
}

function parseLinkTarget(s: string, open: number): { url: string; end: number } | null {
  let depth = 0;
  for (let j = open; j < s.length; j++) {
    const ch = s[j];
    if (ch === "\\") j++;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) {
        let raw = s.slice(open + 1, j).trim();
        const titled = /^(\S+)\s+("[^"]*"|'[^']*')$/.exec(raw);
        if (titled) raw = titled[1];
        if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1);
        if (raw === "" || /\s/.test(raw)) return null;
        return { url: raw, end: j + 1 };
      }
    } else if (ch === "\n") return null;
  }
  return null;
}

const CLOSE_PUNCT = ".,;:!?'\"*_~、。，；：！？）」』”’】》";

function bareUrlEnd(s: string, start: number): number {
  let j = start;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    const ch = s[j];
    if (/\s/.test(ch) || ch === "<" || ch === ">") break;
    if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef))
      break;
    j++;
  }
  // Trim trailing punctuation and unbalanced closing parens.
  while (j > start) {
    const ch = s[j - 1];
    if (CLOSE_PUNCT.indexOf(ch) >= 0) j--;
    else if (ch === ")") {
      let open = 0;
      let close = 0;
      for (let k = start; k < j; k++) {
        if (s[k] === "(") open++;
        else if (s[k] === ")") close++;
      }
      if (close > open) j--;
      else break;
    } else break;
  }
  return j;
}

interface CloseState {
  failedFrom: Record<string, number>;
}

/** Find the start index of a closing delimiter of `len` chars `ch`, or -1. */
function findCloser(
  s: string,
  from: number,
  ch: string,
  len: number,
  state: CloseState,
): { start: number; end: number } | null {
  const key = ch + len;
  const failed = state.failedFrom[key];
  if (failed !== undefined && from >= failed) return null;
  let j = from;
  while (j < s.length) {
    const cj = s[j];
    if (cj === "\\") {
      j += 2;
      continue;
    }
    if (cj === "`") {
      const end = runEnd(s, j, "`");
      const close = findCodeClose(s, end, end - j);
      j = close >= 0 ? close + (end - j) : end;
      continue;
    }
    if (cj !== ch) {
      j++;
      continue;
    }
    const end = runEnd(s, j, ch);
    const run = end - j;
    const prev = s[j - 1];
    const next = s[end];
    let ok = j > from && !isSpace(prev) && run >= len;
    if (ok && len === 1 && run !== 1) ok = false;
    if (ok && ch === "_" && next !== undefined && isAlnum(next.charCodeAt(0))) ok = false;
    if (ok) {
      const start = end - len;
      return { start, end };
    }
    j = end;
  }
  state.failedFrom[key] = state.failedFrom[key] === undefined ? from : Math.min(state.failedFrom[key], from);
  return null;
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  if (depth > MAX_DEPTH) {
    pushText(out, s);
    return out;
  }
  const state: CloseState = { failedFrom: {} };
  let textStart = 0;
  let i = 0;
  const flush = function flush(to: number): void {
    if (to > textStart) pushText(out, s.slice(textStart, to));
  };
  while (i < s.length) {
    const ch = s[i];
    switch (ch) {
      case "\\": {
        const next = s[i + 1];
        if (next === "\n") {
          flush(i);
          out.push({ t: "br" });
          i += 2;
          textStart = i;
        } else if (next !== undefined && isEscapable(next)) {
          flush(i);
          pushText(out, next);
          i += 2;
          textStart = i;
        } else i++;
        break;
      }
      case "\n": {
        // Hard break: two or more trailing spaces before newline.
        let k = i;
        while (k > textStart && s[k - 1] === " ") k--;
        if (i - k >= 2) {
          flush(k);
          out.push({ t: "br" });
          i++;
          textStart = i;
        } else i++;
        break;
      }
      case "`": {
        const end = runEnd(s, i, "`");
        const n = end - i;
        const close = findCodeClose(s, end, n);
        if (close < 0) {
          i = end;
          break;
        }
        flush(i);
        let body = s.slice(end, close).replace(/\n/g, " ");
        if (body.length > 2 && body.startsWith(" ") && body.endsWith(" ") && body.trim() !== "")
          body = body.slice(1, -1);
        out.push({ t: "code", text: body });
        i = close + n;
        textStart = i;
        break;
      }
      case "[": {
        const close = findClosingBracket(s, i);
        if (close > 0 && s[close + 1] === "(") {
          const target = parseLinkTarget(s, close + 1);
          if (target) {
            flush(i);
            const children = parseInline(s.slice(i + 1, close), depth + 1);
            out.push({
              t: "link",
              url: target.url,
              children: children.length > 0 ? children : [{ t: "text", text: target.url }],
            });
            i = target.end;
            textStart = i;
            break;
          }
        }
        i++;
        break;
      }
      case "<": {
        const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(s.slice(i, i + 2000));
        if (m) {
          flush(i);
          out.push({ t: "link", url: m[1], children: [{ t: "text", text: m[1] }] });
          i += m[0].length;
          textStart = i;
        } else i++;
        break;
      }
      case "h": {
        const prevCode = i > 0 ? s.charCodeAt(i - 1) : 0;
        if (
          (s.startsWith("http://", i) || s.startsWith("https://", i)) &&
          !isAlnum(prevCode)
        ) {
          const end = bareUrlEnd(s, i);
          const url = s.slice(i, end);
          if (/^https?:\/\/[^/\s]+/.test(url)) {
            flush(i);
            out.push({ t: "link", url, children: [{ t: "text", text: url }] });
            i = end;
            textStart = i;
            break;
          }
        }
        i++;
        break;
      }
      case "*":
      case "_":
      case "~": {
        const end = runEnd(s, i, ch);
        const n = end - i;
        const next = s[end];
        const prevCode = i > 0 ? s.charCodeAt(i - 1) : 0;
        let opener = !isSpace(next);
        if (ch === "_" && isAlnum(prevCode)) opener = false;
        if (ch === "~" && n !== 2) opener = false;
        if (!opener) {
          i = end;
          break;
        }
        let len = ch === "~" ? 2 : n >= 3 ? 3 : n;
        let close = findCloser(s, i + len, ch, len, state);
        if (!close && len === 3) {
          len = 2;
          close = findCloser(s, i + len, ch, len, state);
        }
        if (!close && len === 2 && ch !== "~" && n >= 2) {
          len = 1;
          close = findCloser(s, i + len, ch, len, state);
        }
        if (!close) {
          i = end;
          break;
        }
        flush(i);
        const inner = parseInline(s.slice(i + len, close.start), depth + 1);
        if (ch === "~") out.push({ t: "strike", children: inner });
        else if (len === 3) out.push({ t: "bold", children: [{ t: "italic", children: inner }] });
        else if (len === 2) out.push({ t: "bold", children: inner });
        else out.push({ t: "italic", children: inner });
        i = close.end;
        textStart = i;
        break;
      }
      default:
        i++;
    }
  }
  flush(s.length);
  return out;
}

// ---------------------------------------------------------------- blocks

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}>/;
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let inCode = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cur += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines: string[], i: number): boolean {
  const head = lines[i];
  const delim = lines[i + 1];
  if (delim === undefined || head.indexOf("|") < 0) return false;
  if (!TABLE_DELIM_RE.test(delim) || delim.indexOf("-") < 0) return false;
  if (delim.indexOf("|") < 0 && head.trim().indexOf("|") < 0) return false;
  return splitRow(head).length === splitRow(delim).length;
}

function listMarker(line: string): { ordered: boolean; num: number; empty: boolean } | null {
  const m = LIST_RE.exec(line);
  if (!m) return null;
  const marker = m[2];
  const ordered = marker.length > 1 || (marker >= "0" && marker <= "9");
  return { ordered, num: ordered ? parseInt(marker, 10) : 0, empty: m[4].trim() === "" };
}

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  if (FENCE_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line)) return true;
  if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) return true;
  const lm = listMarker(line);
  if (lm && !lm.empty && (!lm.ordered || lm.num === 1) && indentOf(line) < 4) return true;
  return isTableStart(lines, i);
}

function alignOf(cell: string): Align {
  const c = cell.trim();
  const l = c.startsWith(":");
  const r = c.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : null;
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (depth > MAX_DEPTH) {
      blocks.push({ type: "paragraph", inline: [{ t: "text", text: lines.slice(i).join("\n") }] });
      break;
    }
    // Fenced code (unclosed fence runs to end: text streams in).
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = fence[1];
      const fch = marker[0];
      const body: string[] = [];
      const open = indentOf(line);
      let closed = false;
      i++;
      while (i < lines.length) {
        const t = lines[i].trim();
        if (t.length >= marker.length && t === fch.repeat(t.length)) {
          i++;
          closed = true;
          break;
        }
        body.push(open > 0 ? lines[i].replace(new RegExp("^ {0," + open + "}"), "") : lines[i]);
        i++;
      }
      blocks.push({ type: "code", lang: fence[2], text: body.join("\n"), closed });
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      const text = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").replace(/^#+[ \t]*$/, "").trim();
      blocks.push({ type: "heading", level: heading[1].length, inline: parseInline(text) });
      i++;
      continue;
    }
    if (HR_RE.test(line)) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }
    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        inner.push(lines[i].replace(/^ {0,3}> ?/, ""));
        i++;
      }
      blocks.push({ type: "quote", children: parseBlocks(inner, depth + 1) });
      continue;
    }
    const lm = listMarker(line);
    if (lm && indentOf(line) < 4) {
      i = parseList(lines, i, depth, blocks);
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() !== "" && lines[i].indexOf("|") >= 0) {
        const cells = splitRow(lines[i]);
        const row: Inline[][] = [];
        for (let c = 0; c < header.length; c++) row.push(parseInline(cells[c] ?? ""));
        rows.push(row);
        i++;
      }
      blocks.push({ type: "table", align, header: header.map((h) => parseInline(h)), rows });
      continue;
    }
    // Paragraph
    const para: string[] = [line.replace(/^\s+/, "")];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines, i)) {
      para.push(lines[i].replace(/^\s+/, ""));
      i++;
    }
    blocks.push({ type: "paragraph", inline: parseInline(para.join("\n").replace(/\s+$/, "")) });
  }
  return blocks;
}

function parseList(lines: string[], from: number, depth: number, blocks: Block[]): number {
  const first = listMarker(lines[from]);
  if (!first) return from + 1;
  const baseIndent = indentOf(lines[from]);
  const items: ListItem[] = [];
  let i = from;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    const lm = listMarker(lines[i]);
    if (!m || !lm || lm.ordered !== first.ordered || indentOf(lines[i]) > baseIndent) break;
    const spaces = m[3].length;
    const contentIndent = m[1].length + m[2].length + (spaces > 4 || spaces === 0 ? 1 : spaces);
    const itemLines: string[] = [m[4]];
    i++;
    while (i < lines.length) {
      const cur = lines[i];
      if (cur.trim() === "") {
        let k = i;
        while (k < lines.length && lines[k].trim() === "") k++;
        if (k < lines.length && indentOf(lines[k]) > baseIndent) {
          for (let b = i; b < k; b++) itemLines.push("");
          i = k;
          continue;
        }
        break;
      }
      const ind = indentOf(cur);
      if (ind > baseIndent) {
        itemLines.push(cur.slice(Math.min(ind, contentIndent)));
        i++;
        continue;
      }
      // Lazy continuation of a paragraph.
      if (ind <= baseIndent && !listMarker(cur) && !startsBlock(lines, i) && itemLines[itemLines.length - 1].trim() !== "") {
        itemLines.push(cur.trim());
        i++;
        continue;
      }
      break;
    }
    let checked: boolean | null = null;
    const task = /^\[([ xX])\][ \t]+/.exec(itemLines[0]);
    if (task) {
      checked = task[1] !== " ";
      itemLines[0] = itemLines[0].slice(task[0].length);
    }
    items.push({ checked, children: parseBlocks(itemLines, depth + 1) });
    // Skip blank lines between sibling items.
    let k = i;
    while (k < lines.length && lines[k].trim() === "") k++;
    if (k > i && k < lines.length) {
      const nm = listMarker(lines[k]);
      if (nm && nm.ordered === first.ordered && indentOf(lines[k]) <= baseIndent && indentOf(lines[k]) >= baseIndent) i = k;
    }
  }
  blocks.push({ type: "list", ordered: first.ordered, start: first.ordered ? first.num : 1, items });
  return i;
}

function expandTabs(line: string): string {
  return line.replace(/^\t+/, (m) => "    ".repeat(m.length));
}

export function parseMarkdown(text: string): Block[] {
  try {
    const lines = text.replace(/\r\n?/g, "\n").split("\n").map(expandTabs);
    return parseBlocks(lines, 0);
  } catch {
    return [{ type: "paragraph", inline: [{ t: "text", text }] }];
  }
}

/** Plain text of inline nodes (used for tests and accessibility). */
export function inlineToText(nodes: Inline[]): string {
  let out = "";
  for (const node of nodes) {
    if (node.t === "text" || node.t === "code") out += node.text;
    else if (node.t === "br") out += "\n";
    else out += inlineToText(node.children);
  }
  return out;
}

/** Estimated width in em units of the longest line of inline nodes (CJK ≈ 1em). */
export function inlineUnits(nodes: Inline[]): number {
  let max = 0;
  for (const line of inlineToText(nodes).split("\n")) {
    let units = 0;
    for (const ch of line) {
      units += (ch.codePointAt(0) ?? 0) >= 0x2e80 ? 1 : 0.55;
    }
    if (units > max) max = units;
  }
  return max;
}

/** Per-column max content width in em units; header counts slightly wider (bold). */
export function tableColumnUnits(header: Inline[][], rows: Inline[][][]): number[] {
  const units = new Array<number>(header.length).fill(0);
  const scan = function scan(cells: Inline[][], boost: number): void {
    for (let c = 0; c < units.length; c++) {
      const u = inlineUnits(cells[c] ?? []) * boost;
      if (u > units[c]) units[c] = u;
    }
  };
  scan(header, 1.08);
  for (const row of rows) scan(row, 1);
  return units;
}
