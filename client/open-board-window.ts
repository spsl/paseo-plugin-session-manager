import {
  buildStandaloneBoardUrl,
  createHandoff,
  decideHandoff,
  HANDOFF_KEY,
  STANDALONE_PARAM,
} from "../shared/standalone-board";
import {
  currentHref,
  isDesktop,
  openNewWindow,
  setFullscreen,
  storageGet,
  storageRemove,
  storageSet,
  windowOpen,
} from "./desktop-bridge";

const WINDOW_ORIGIN = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const NOTICE_NO_WINDOW = "no-window";
const RETRY_MS = 500;
const RETRY_LIMIT = 10;

export const FALLBACK_HINT =
  "无法自动打开新窗口：请按 ⌘N 新开窗口，在侧边栏打开会话看板后按 ⌃⌘F 全屏";

/** Opens a new window carrying the handoff flag. Returns false when every strategy failed. */
export function openBoardInNewWindow(): boolean {
  if (!isDesktop()) {
    return false;
  }
  storageSet(HANDOFF_KEY, createHandoff(Date.now(), WINDOW_ORIGIN));
  if (openNewWindow()) {
    return true;
  }
  storageRemove(HANDOFF_KEY);
  const href = currentHref();
  const url = href === null ? null : buildStandaloneBoardUrl(href);
  return url !== null && windowOpen(url);
}

/** Called from contribute(): the freshly opened window shows the board fullscreen. */
export function consumeBoardHandoff(openBoard: (params: Record<string, string>) => void): void {
  if (!isDesktop()) {
    return;
  }
  const decision = decideHandoff(storageGet(HANDOFF_KEY), Date.now(), WINDOW_ORIGIN);
  if (decision === "ignore") {
    return;
  }
  storageRemove(HANDOFF_KEY);
  if (decision !== "consume") {
    return;
  }
  let attempts = 0;
  function attempt(): void {
    attempts += 1;
    let opened = false;
    try {
      openBoard({ [STANDALONE_PARAM]: "1" });
      opened = true;
    } catch {
      opened = false;
    }
    if (opened) {
      setFullscreen(true);
      return;
    }
    if (attempts < RETRY_LIMIT) {
      setTimeout(attempt, RETRY_MS);
    }
  }
  setTimeout(attempt, RETRY_MS);
}
