/**
 * Feature-detected access to Paseo's (unofficial) Electron desktop bridge.
 * No DOM lib is available, so everything goes through globalThis with local
 * structural types. On iOS/Android (Hermes) `window` is undefined and every
 * helper degrades to false/null, so this file is safe on all platforms.
 */

interface DesktopWindowApi {
  openNew?: (options: Record<string, unknown>) => unknown;
  getCurrentWindow?: () => {
    setFullscreen?: (on: boolean) => unknown;
    isFullscreen?: () => unknown;
  };
}

interface BridgeGlobal {
  window?: {
    paseoDesktop?: { window?: DesktopWindowApi };
    localStorage?: {
      getItem(key: string): string | null;
      setItem(key: string, value: string): void;
      removeItem(key: string): void;
    };
    open?: (url: string, target: string) => unknown;
  };
  location?: { href?: string };
}

function bridge(): BridgeGlobal["window"] | undefined {
  return (globalThis as unknown as BridgeGlobal).window;
}

function desktopWindow(): DesktopWindowApi | null {
  try {
    return bridge()?.paseoDesktop?.window ?? null;
  } catch {
    return null;
  }
}

export function isDesktop(): boolean {
  return desktopWindow() !== null;
}

export function currentHref(): string | null {
  try {
    const href = (globalThis as unknown as BridgeGlobal).location?.href;
    return typeof href === "string" ? href : null;
  } catch {
    return null;
  }
}

export function openNewWindow(): boolean {
  try {
    const open = desktopWindow()?.openNew;
    if (typeof open !== "function") {
      return false;
    }
    open({});
    return true;
  } catch {
    return false;
  }
}

export function setFullscreen(on: boolean): boolean {
  try {
    const current = desktopWindow()?.getCurrentWindow?.();
    if (!current || typeof current.setFullscreen !== "function") {
      return false;
    }
    current.setFullscreen(on);
    return true;
  } catch {
    return false;
  }
}

/** Resolves to null when unknown. */
export function isFullscreen(): Promise<boolean | null> {
  try {
    const current = desktopWindow()?.getCurrentWindow?.();
    if (!current || typeof current.isFullscreen !== "function") {
      return Promise.resolve(null);
    }
    return Promise.resolve(current.isFullscreen()).then(
      function ok(value) {
        return typeof value === "boolean" ? value : null;
      },
      function fail() {
        return null;
      },
    );
  } catch {
    return Promise.resolve(null);
  }
}

export function windowOpen(url: string): boolean {
  try {
    const open = bridge()?.open;
    if (typeof open !== "function") {
      return false;
    }
    return open(url, "_blank") != null;
  } catch {
    return false;
  }
}

export function storageGet(key: string): string | null {
  try {
    return bridge()?.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string): boolean {
  try {
    const storage = bridge()?.localStorage;
    if (!storage) {
      return false;
    }
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function storageRemove(key: string): void {
  try {
    bridge()?.localStorage?.removeItem(key);
  } catch {
    // ignore
  }
}
