import { DEFAULT_ANALYZER_SETTINGS, type AnalyzerSettings } from "../shared/settings";
import type { SettingsProvider } from "./service";

type SettingsHandle = {
  read(): Promise<
    { status: "ready"; values: AnalyzerSettings } | { status: string; error?: string }
  >;
  subscribe(listener: () => void): () => void;
};

/** Caches settings so the queue can read them synchronously. */
export class SettingsCache implements SettingsProvider {
  private value: AnalyzerSettings = { ...DEFAULT_ANALYZER_SETTINGS };
  private warned = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly handle: SettingsHandle,
    private readonly onChange: () => void,
  ) {}

  current(): AnalyzerSettings {
    return this.value;
  }

  async refresh(): Promise<AnalyzerSettings> {
    try {
      const state = await this.handle.read();
      if (state.status === "ready" && "values" in state) {
        this.value = { ...DEFAULT_ANALYZER_SETTINGS, ...state.values };
      } else if (!this.warned) {
        this.warned = true;
        console.warn(
          `[session-manager] settings unavailable (${state.status}), using defaults`,
          "error" in state ? state.error : "",
        );
      }
    } catch (error) {
      if (!this.warned) {
        this.warned = true;
        console.warn("[session-manager] could not read settings, using defaults", error);
      }
    }
    return this.value;
  }

  start(): void {
    void this.refresh().then(() => this.onChange());
    this.unsubscribe = this.handle.subscribe(() => {
      void this.refresh().then(() => this.onChange());
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
