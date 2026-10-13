/**
 * Composer image model and the Data URL -> bare Base64 conversion every send
 * path shares. `data` never carries a `data:…;base64,` prefix; `uri` exists
 * only for the preview tray and is never sent to the daemon.
 * Pure TS, no DOM, no async arrows (Hermes).
 */
import type { AgentHandle } from "./use-conversation";

export type ComposerImage = {
  id: string;
  mimeType: string;
  /** Bare Base64 payload (no `data:` prefix). */
  data: string;
  /** Full Data URL, preview only. */
  uri: string;
};

type SendOptions = NonNullable<Parameters<AgentHandle["send"]>[1]>;
type SendImages = NonNullable<SendOptions["images"]>;

/**
 * Accepts only `data:image/<subtype>;base64,<payload>` and splits at the first
 * comma, so commas inside the payload survive. Anything else -> null.
 */
export function parseImageDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) {
    return null;
  }
  const header = dataUrl.slice(0, comma);
  const data = dataUrl.slice(comma + 1);
  const match = /^data:(image\/[^;,]+);base64$/i.exec(header);
  if (!match || data === "") {
    return null;
  }
  return { mimeType: match[1], data };
}

/** Strips `id` and `uri`, returning fresh `{data, mimeType}` objects. */
export function toSendImages(images: readonly ComposerImage[]): SendImages {
  return images.map(function toSend(image) {
    return { data: image.data, mimeType: image.mimeType };
  });
}

/** Omits `images` entirely when empty; the daemon must never see `[]`. */
export function imagesOption(images: readonly ComposerImage[]): { images?: SendImages } {
  return images.length === 0 ? {} : { images: toSendImages(images) };
}
