/**
 * Composer drafts, persisted per session so a half-written message survives an
 * app restart. One small JSON map file, debounced tmp+rename writes like
 * `JsonStateStore`.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PERSISTED_DRAFTS_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 400;
export const MAX_DRAFT_CHARS = 20_000;
export const MAX_DRAFTS = 100;

function hydrateDrafts(value: unknown): Map<string, string> {
  const drafts = new Map<string, string>();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return drafts;
  }
  for (const [sessionId, draft] of Object.entries(value as Record<string, unknown>)) {
    if (typeof draft === "string" && draft.trim() !== "") {
      drafts.set(sessionId, draft.slice(0, MAX_DRAFT_CHARS));
    }
  }
  return drafts;
}

export class DraftStore {
  private drafts = new Map<string, string>();
  private touched = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Unsaved changes; a flush without any must not overwrite the file. */
  private dirty = false;
  private loading: Promise<unknown> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private counter = 0;

  constructor(private readonly path: string) {}

  /** Reads the file once; later calls return the same promise's map. */
  load(): Promise<void> {
    if (this.loading === null) {
      this.loading = this.read().then((drafts) => {
        this.drafts = drafts;
        // Loaded entries keep a baseline recency so a save never drops them.
        for (const sessionId of drafts.keys()) {
          this.touched.set(sessionId, 0);
        }
      });
    }
    return this.loading.then(() => undefined);
  }

  private async read(): Promise<Map<string, string>> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as {
        version?: number;
        drafts?: unknown;
      };
      if (parsed?.version !== PERSISTED_DRAFTS_VERSION) {
        return new Map();
      }
      return hydrateDrafts(parsed.drafts);
    } catch {
      return new Map();
    }
  }

  get(sessionId: string): string | null {
    return this.drafts.get(sessionId) ?? null;
  }

  /** `null` or blank clears the draft. */
  set(sessionId: string, draft: string | null): void {
    const text = typeof draft === "string" ? draft.slice(0, MAX_DRAFT_CHARS) : "";
    if (text.trim() === "") {
      this.drafts.delete(sessionId);
    } else {
      this.drafts.set(sessionId, text);
    }
    this.touched.set(sessionId, Date.now());
    this.dirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, PERSIST_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private bounded(): Record<string, string> {
    const entries = [...this.touched.entries()]
      .filter(([sessionId]) => this.drafts.has(sessionId))
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_DRAFTS);
    const drafts: Record<string, string> = {};
    for (const [sessionId] of entries) {
      drafts[sessionId] = this.drafts.get(sessionId) ?? "";
    }
    return drafts;
  }

  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) {
      // Nothing changed (possibly never loaded): writing would wipe saved drafts.
      await this.writing;
      return;
    }
    this.dirty = false;
    const run = async (): Promise<void> => {
      await this.loading?.catch(() => undefined);
      try {
        const directory = dirname(this.path);
        this.counter += 1;
        const temporaryPath = join(
          directory,
          `.drafts-${process.pid}-${Date.now()}-${this.counter}.tmp`,
        );
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(
          temporaryPath,
          JSON.stringify({ version: PERSISTED_DRAFTS_VERSION, drafts: this.bounded() }),
          { mode: 0o600 },
        );
        await rename(temporaryPath, this.path);
      } catch (error) {
        console.warn("[session-manager] could not persist drafts", error);
      }
    };
    this.writing = this.writing.then(run);
    await this.writing;
  }
}
