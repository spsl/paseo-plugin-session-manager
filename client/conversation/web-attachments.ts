/**
 * Web-only composer helpers: DOM access for paste/drag/pick image support,
 * textarea measuring and autofocus retries. No DOM lib is available, so
 * everything goes through globalThis with structural types (same pattern as
 * desktop-bridge.ts); on Hermes every lookup fails and helpers degrade to
 * null/no-op, so the "+" entry stays hidden off-web.
 */
import { parseImageDataUrl, type ComposerImage } from "./composer-images";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_READ_ERROR = "无法粘贴图片";

export type DomNode = {
  addEventListener?: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void;
  style?: Record<string, string | undefined>;
  scrollHeight?: number;
  focus?: () => void;
  click?: () => void;
  type?: string;
  accept?: string;
  multiple?: boolean;
};

type ClipboardItemLike = {
  kind?: string;
  type?: string;
  getAsFile?: () => unknown;
};

type DomClipboardEvent = {
  preventDefault?: () => void;
  clipboardData?: { items?: ArrayLike<ClipboardItemLike> };
};

type DomDragEvent = {
  preventDefault?: () => void;
  dataTransfer?: { files?: ArrayLike<unknown> };
};

type DomChangeEvent = {
  target?: { files?: ArrayLike<unknown> };
};

type FileLike = { size?: number; type?: string };

type FileReaderLike = {
  readAsDataURL(file: unknown): void;
  result?: unknown;
  onload: ((event: { target?: { result?: unknown } }) => void) | null;
  onerror: (() => void) | null;
};

interface DomGlobal {
  document?: {
    activeElement?: unknown;
    createElement?: (tag: string) => DomNode;
  };
  FileReader?: new () => FileReaderLike;
  requestAnimationFrame?: (callback: () => void) => number;
  matchMedia?: (query: string) => { matches: boolean };
}

function dom(): DomGlobal {
  try {
    return globalThis as unknown as DomGlobal;
  } catch {
    return {};
  }
}

function isDomNode(node: unknown): node is DomNode {
  const candidate = node as DomNode | null | undefined;
  return (
    candidate !== null &&
    candidate !== undefined &&
    typeof candidate === "object" &&
    typeof candidate.addEventListener === "function" &&
    typeof candidate.removeEventListener === "function"
  );
}

/** The host node behind an SDK/RN-web ref (`getNativeRef()` or the ref). */
export function domInputNode(ref: unknown): DomNode | null {
  if (ref === null || typeof ref !== "object") {
    return null;
  }
  const holder = ref as { getNativeRef?: () => unknown };
  const node = typeof holder.getNativeRef === "function" ? holder.getNativeRef() : ref;
  return isDomNode(node) ? node : null;
}

/** True when the node is a real textarea-like element we can measure on. */
export function canMeasureTextarea(node: DomNode | null): boolean {
  return (
    node !== null &&
    typeof node.scrollHeight === "number" &&
    node.style !== null &&
    typeof node.style === "object"
  );
}

/** Paseo's own trick: height -> auto, read scrollHeight, restore. */
export function measureTextarea(node: DomNode): number {
  const style = node.style ?? {};
  const previous = style["height"];
  style["height"] = "auto";
  const measured = node.scrollHeight ?? 0;
  style["height"] = previous ?? "";
  return measured;
}

function imageFilesFromList(files: ArrayLike<unknown> | undefined): unknown[] {
  const out: unknown[] = [];
  if (files === undefined) {
    return out;
  }
  for (let i = 0; i < files.length; i++) {
    const file = files[i] as FileLike | null;
    if (file !== null && typeof file === "object" && typeof file.type === "string" && file.type.startsWith("image/")) {
      out.push(file);
    }
  }
  return out;
}

function imageFilesFromClipboard(items: ArrayLike<ClipboardItemLike> | undefined): unknown[] {
  const out: unknown[] = [];
  if (items === undefined) {
    return out;
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (
      item !== null &&
      typeof item === "object" &&
      item.kind === "file" &&
      typeof item.type === "string" &&
      item.type.startsWith("image/") &&
      typeof item.getAsFile === "function"
    ) {
      const file = item.getAsFile();
      if (file !== null) {
        out.push(file);
      }
    }
  }
  return out;
}

/**
 * Paste on the input (images only; text paste falls through) and drag/drop on
 * the composer frame. Returns a cleanup; a no-op when either node fails the
 * feature check.
 */
export function attachComposerDomListeners(
  input: DomNode | null,
  box: DomNode | null,
  handlers: {
    onImageFiles(files: unknown[]): void;
    onDragActive(active: boolean): void;
  },
): () => void {
  if (!isDomNode(input) || !isDomNode(box)) {
    return function noop() {};
  }
  let depth = 0;

  function onPaste(event: unknown): void {
    const e = event as DomClipboardEvent;
    const files = imageFilesFromClipboard(e.clipboardData?.items);
    if (files.length === 0) {
      return;
    }
    e.preventDefault?.();
    handlers.onImageFiles(files);
  }
  function onDragEnter(event: unknown): void {
    (event as DomDragEvent).preventDefault?.();
    depth += 1;
    handlers.onDragActive(true);
  }
  function onDragOver(event: unknown): void {
    (event as DomDragEvent).preventDefault?.();
  }
  function onDragLeave(): void {
    depth = Math.max(0, depth - 1);
    if (depth === 0) {
      handlers.onDragActive(false);
    }
  }
  function onDrop(event: unknown): void {
    const e = event as DomDragEvent;
    e.preventDefault?.();
    depth = 0;
    handlers.onDragActive(false);
    const files = imageFilesFromList(e.dataTransfer?.files);
    if (files.length > 0) {
      handlers.onImageFiles(files);
    }
  }

  input.addEventListener?.("paste", onPaste);
  box.addEventListener?.("dragenter", onDragEnter);
  box.addEventListener?.("dragover", onDragOver);
  box.addEventListener?.("dragleave", onDragLeave);
  box.addEventListener?.("drop", onDrop);
  return function detach() {
    input.removeEventListener?.("paste", onPaste);
    box.removeEventListener?.("dragenter", onDragEnter);
    box.removeEventListener?.("dragover", onDragOver);
    box.removeEventListener?.("dragleave", onDragLeave);
    box.removeEventListener?.("drop", onDrop);
  };
}

/** Opens the file picker for images; false when DOM is unavailable. */
export function pickImages(onFiles: (files: unknown[]) => void): boolean {
  const document_ = dom().document;
  if (document_ === undefined || typeof document_.createElement !== "function") {
    return false;
  }
  const input = document_.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.multiple = true;
  input.addEventListener?.("change", function onChange(event) {
    const files = imageFilesFromList((event as DomChangeEvent).target?.files);
    if (files.length > 0) {
      onFiles(files);
    }
  });
  input.click?.();
  return true;
}

let nextImageId = 1;

/**
 * Reads one File into a ComposerImage. Oversize files, missing FileReader and
 * unparseable Data URLs all report `IMAGE_READ_ERROR`.
 */
export function readImageFile(
  file: unknown,
  done: (image: ComposerImage | null, error: string | null) => void,
): void {
  const size = (file as FileLike).size;
  if (typeof size === "number" && size > MAX_IMAGE_BYTES) {
    done(null, IMAGE_READ_ERROR);
    return;
  }
  const Reader = dom().FileReader;
  if (Reader === undefined) {
    done(null, IMAGE_READ_ERROR);
    return;
  }
  const reader = new Reader();
  reader.onload = function loaded(event) {
    const result = event?.target?.result ?? reader.result;
    const parsed = typeof result === "string" ? parseImageDataUrl(result) : null;
    if (parsed === null || typeof result !== "string") {
      done(null, IMAGE_READ_ERROR);
      return;
    }
    done(
      {
        id: `img${nextImageId++}`,
        mimeType: parsed.mimeType,
        data: parsed.data,
        uri: result,
      },
      null,
    );
  };
  reader.onerror = function failed() {
    done(null, IMAGE_READ_ERROR);
  };
  reader.readAsDataURL(file);
}

/** Desktop precision pointer check; assumed true when matchMedia is missing. */
export function hasPrecisePointer(): boolean {
  const matchMedia = dom().matchMedia;
  if (matchMedia === undefined) {
    return true;
  }
  try {
    return matchMedia("(pointer:fine)").matches;
  } catch {
    return true;
  }
}

/**
 * Focuses the input, retrying on rAF until it sticks (Paseo does the same for
 * ~1.5s after mount, when the host may steal focus back). Returns a cancel.
 */
export function autofocusInput(node: DomNode | null): () => void {
  const raf = dom().requestAnimationFrame;
  if (node === null || typeof node.focus !== "function" || raf === undefined) {
    return function noop() {};
  }
  const target: DomNode = node;
  const schedule: (callback: () => void) => number = raf;
  const deadline = Date.now() + 1500;
  let cancelled = false;
  function attempt(): void {
    if (cancelled || Date.now() > deadline) {
      return;
    }
    target.focus?.();
    if (dom().document?.activeElement === target) {
      return;
    }
    schedule(attempt);
  }
  schedule(attempt);
  return function cancel() {
    cancelled = true;
  };
}

/** Plain focus used after send/stop completes. */
export function focusInput(node: DomNode | null): void {
  node?.focus?.();
}

type DomKeyEvent = {
  key?: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  preventDefault?: () => void;
};

/** Cmd/Ctrl+L focuses the composer input (document-level, web only). */
export function attachFocusShortcut(node: DomNode | null): () => void {
  const target = dom().document as (DomNode & { activeElement?: unknown }) | undefined;
  if (node === null || target === undefined || typeof target.addEventListener !== "function") {
    return function noop() {};
  }
  const input = node;
  function onKeydown(event: unknown): void {
    const e = event as DomKeyEvent;
    if ((e.metaKey === true || e.ctrlKey === true) && (e.key === "l" || e.key === "L")) {
      e.preventDefault?.();
      input.focus?.();
    }
  }
  target.addEventListener("keydown", onKeydown);
  return function detach() {
    target.removeEventListener?.("keydown", onKeydown);
  };
}
