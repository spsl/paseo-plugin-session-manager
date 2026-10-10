import { DEFAULT_SPEECH_SETTINGS, type SpeechSettings } from "../shared/speech";

type SpeechSettingsHandle = {
  read(): Promise<
    { status: "ready"; values: SpeechSettings } | { status: string; error?: string }
  >;
  subscribe(listener: () => void): () => void;
};

/** Caches the speech settings so event handlers can gate announcements synchronously. */
export class SpeechSettingsCache {
  private value: SpeechSettings = { ...DEFAULT_SPEECH_SETTINGS };
  private warned = false;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly handle: SpeechSettingsHandle) {}

  current(): SpeechSettings {
    return this.value;
  }

  async refresh(): Promise<SpeechSettings> {
    try {
      const state = await this.handle.read();
      if (state.status === "ready" && "values" in state) {
        this.value = { ...DEFAULT_SPEECH_SETTINGS, ...state.values };
      } else if (!this.warned) {
        this.warned = true;
        console.warn(`[session-manager] speech settings unavailable (${state.status}), using defaults`);
      }
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn("[session-manager] could not read speech settings, using defaults", error);
      }
    }
    return this.value;
  }

  start(): void {
    void this.refresh();
    this.unsubscribe = this.handle.subscribe(() => {
      void this.refresh();
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
