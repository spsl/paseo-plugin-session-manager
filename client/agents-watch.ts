/**
 * Hearing Paseo's agent stream (ported from herald `client/agents.ts`).
 * `agents.subscribe()` only hears observations opened through
 * `agents.list({ subscribe })` on the same API instance, so that is opened here
 * and released on cleanup. Failed observations are reopened with backoff.
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { SNAPSHOT_QUERY_KEY } from "./use-snapshot";

type Paseo = PluginClientContext["paseo"];
type AgentObservation = Awaited<ReturnType<typeof openObservation>>["subscription"];

const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 60_000;
const NUDGE_DEBOUNCE_MS = 400;

function openObservation(paseo: Paseo, signal: AbortSignal) {
  return paseo.agents.list({ subscribe: {}, page: { limit: 1 }, signal });
}

/** Calls onUpdate for every agent update until the returned cleanup runs. */
export function watchAgents(paseo: Paseo, onUpdate: () => void): () => void {
  const lifetime = new AbortController();
  let observation: AgentObservation | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = RETRY_MIN_MS;

  function reopen(error: unknown): void {
    observation = null;
    if (lifetime.signal.aborted || retry !== null) return;
    console.warn("[session-manager] the agent stream failed; reopening", error);
    retry = setTimeout(function retryOpen() {
      retry = null;
      open();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  }

  function open(): void {
    openObservation(paseo, lifetime.signal)
      .then(function opened({ subscription }) {
        if (lifetime.signal.aborted) {
          void subscription.release().catch(function ignore() {
            return undefined;
          });
          return;
        }
        observation = subscription;
        subscription.subscribe({
          snapshot() {
            retryDelay = RETRY_MIN_MS;
          },
          update(message) {
            if (message.type === "agent_update") onUpdate();
          },
          error: reopen,
        });
      })
      .catch(reopen);
  }

  open();
  return function stop() {
    lifetime.abort();
    if (retry !== null) clearTimeout(retry);
    retry = null;
    if (observation !== null) {
      void observation.release().catch(function ignore() {
        return undefined;
      });
    }
    observation = null;
  };
}

/** Refetches the snapshot shortly (400ms debounce) after any agent update. */
export function useSnapshotNudges(): void {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  useEffect(
    function watch() {
      let debounce: ReturnType<typeof setTimeout> | null = null;
      const unwatch = watchAgents(paseo, function nudge() {
        if (debounce !== null) clearTimeout(debounce);
        debounce = setTimeout(function fire() {
          debounce = null;
          void queryClient.invalidateQueries(
            { queryKey: SNAPSHOT_QUERY_KEY },
            { cancelRefetch: false },
          );
        }, NUDGE_DEBOUNCE_MS);
      });
      return function cleanup() {
        if (debounce !== null) clearTimeout(debounce);
        unwatch();
      };
    },
    [paseo, queryClient],
  );
}
