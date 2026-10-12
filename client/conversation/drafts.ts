/**
 * Composer draft per session: a module-level cache backed by the daemon-side
 * `drafts.json` store, so text survives pane switches and app restarts.
 * Writes are debounced; the cache repaints immediately.
 * No async arrows (Hermes).
 */
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { draftGetRpc, draftSetRpc } from "../../shared/rpc";

const WRITE_DEBOUNCE_MS = 600;

const cache = new Map<string, string>();
const loaded = new Set<string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<(sessionId: string) => void>();

function notify(sessionId: string): void {
  const snapshot = [...listeners];
  for (const listener of snapshot) {
    listener(sessionId);
  }
}

/** Latest cached value; `null` until the server copy has been read once. */
export function cachedDraft(sessionId: string): string | null {
  return loaded.has(sessionId) ? cache.get(sessionId) ?? "" : null;
}

export function useComposerDraft(sessionId: string): {
  draft: string;
  ready: boolean;
  setDraft(value: string): void;
} {
  const getDraft = useRpc(draftGetRpc);
  const setDraftRpc = useRpc(draftSetRpc);
  const [draft, setDraftState] = useState<string>(function initial() {
    return cache.get(sessionId) ?? "";
  });
  const [ready, setReady] = useState<boolean>(function initialReady() {
    return loaded.has(sessionId);
  });
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // First load: pull the persisted draft once per session, then stay on cache.
  useEffect(
    function loadOnce() {
      if (loaded.has(sessionId)) {
        return undefined;
      }
      let alive = true;
      void getDraft({ sessionId })
        .then(function apply(result) {
          if (!alive) {
            return;
          }
          loaded.add(sessionId);
          // Only a never-typed draft yields to the saved one.
          if (!cache.has(sessionId) && result.draft !== null) {
            cache.set(sessionId, result.draft);
            if (alive) {
              draftRef.current = result.draft;
              setDraftState(result.draft);
            }
            notify(sessionId);
          }
          setReady(true);
        })
        .catch(function ignore() {
          if (alive) {
            loaded.add(sessionId);
            setReady(true);
          }
        });
      return function detach() {
        alive = false;
      };
    },
    [sessionId, getDraft],
  );

  // Repaint when the same session's draft is edited from another mounted pane.
  useEffect(
    function syncAcrossPanes() {
      return subscribeDrafts(function onDraft(changedId, value) {
        if (changedId === sessionId && value !== draftRef.current) {
          draftRef.current = value;
          setDraftState(value);
        }
      });
    },
    [sessionId],
  );

  const setDraft = useCallback(
    function setDraft(value: string): void {
      loaded.add(sessionId);
      cache.set(sessionId, value);
      draftRef.current = value;
      setDraftState(value);
      notify(sessionId);
      const pending = timers.get(sessionId);
      if (pending) {
        clearTimeout(pending);
      }
      timers.set(
        sessionId,
        setTimeout(function persist() {
          timers.delete(sessionId);
          const text = cache.get(sessionId) ?? "";
          void setDraftRpc({ sessionId, draft: text === "" ? null : text }).catch(function ignore() {
            // Drafts are best-effort; the in-memory cache still has them.
          });
        }, WRITE_DEBOUNCE_MS),
      );
    },
    [sessionId, setDraftRpc],
  );

  return { draft, ready, setDraft };
}

function subscribeDrafts(listener: (sessionId: string, value: string) => void): () => void {
  const wrapped = function onDraft(sessionId: string): void {
    listener(sessionId, cache.get(sessionId) ?? "");
  };
  listeners.add(wrapped);
  return function unsubscribe() {
    listeners.delete(wrapped);
  };
}
