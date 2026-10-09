/**
 * Live conversation data for one Paseo agent: initial tail load, older pages,
 * live stream merge and agent snapshot (status / pending permissions).
 * Async function declarations only (Hermes); no closures inside for...of.
 */
import { usePaseo } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_STATE,
  mergeStreamEvent,
  prependOlder,
  stateFromFetch,
  type ConversationState,
  type FetchedEntry,
  type StreamPayload,
} from "./model";
import type { PermissionRequestLike } from "./permissions";

const TAIL_LIMIT = 200;
const OLDER_LIMIT = 100;
const SAFETY_NET_MS = 3_000;

type PaseoApi = ReturnType<typeof usePaseo>;
export type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;

export type AgentInfo = {
  status: string | null;
  running: boolean;
  pending: PermissionRequestLike[];
};

const NO_AGENT: AgentInfo = { status: null, running: false, pending: [] };

type PageLike = {
  entries?: readonly FetchedEntry[];
  epoch?: string | null;
  hasOlder?: boolean;
  startCursor?: unknown;
  error?: unknown;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readAgent(handle: AgentHandle): AgentInfo {
  const status = handle.status ?? null;
  const pending = (handle.pendingPermissions ?? []) as unknown as PermissionRequestLike[];
  const running = status === "running" || handle.activeTurn !== null;
  return { status, running, pending };
}

export type Conversation = {
  handle: AgentHandle;
  state: ConversationState;
  agent: AgentInfo;
  loading: boolean;
  error: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder(): Promise<void>;
  reload(): Promise<void>;
  refreshAgent(): Promise<void>;
};

export function useConversation(sessionId: string): Conversation {
  const paseo = usePaseo();
  const handle = useMemo(
    function resolve(): AgentHandle {
      return paseo.agents.ref(sessionId);
    },
    [paseo, sessionId],
  );
  const [state, setState] = useState<ConversationState>(EMPTY_STATE);
  const stateRef = useRef<ConversationState>(EMPTY_STATE);
  const [agent, setAgent] = useState<AgentInfo>(NO_AGENT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderCursor = useRef<unknown>(null);
  const requestId = useRef(0);
  const lastEventAt = useRef(0);
  const fetching = useRef(false);
  const queued = useRef(false);
  const alive = useRef(true);

  const commit = useCallback(function commit(next: ConversationState): void {
    stateRef.current = next;
    setState(next);
  }, []);

  const refreshAgent = useCallback(
    async function refreshAgent(): Promise<void> {
      try {
        await handle.refresh();
      } catch {
        // Snapshot stays as last observed.
      }
      if (alive.current) {
        setAgent(readAgent(handle));
      }
    },
    [handle],
  );

  const reload = useCallback(
    async function reload(): Promise<void> {
      if (fetching.current) {
        queued.current = true;
        return;
      }
      fetching.current = true;
      const ticket = requestId.current + 1;
      requestId.current = ticket;
      try {
        const page = (await handle.timeline.refetch({
          direction: "tail",
          limit: TAIL_LIMIT,
          projection: "projected",
        })) as unknown as PageLike;
        if (!alive.current || ticket !== requestId.current) {
          return;
        }
        if (page.error) {
          setError(messageOf(page.error));
        } else {
          setError(null);
          commit(stateFromFetch(page.entries ?? [], page.epoch ?? null));
          olderCursor.current = page.startCursor ?? null;
          setHasOlder(page.hasOlder === true && page.startCursor != null);
        }
        setAgent(readAgent(handle));
      } catch (caught) {
        if (alive.current) {
          setError(messageOf(caught));
        }
      } finally {
        fetching.current = false;
        if (alive.current) {
          setLoading(false);
        }
        if (queued.current && alive.current) {
          queued.current = false;
          void reloadRef.current();
        }
      }
    },
    [handle, commit],
  );

  const reloadRef = useRef(reload);
  reloadRef.current = reload;

  const loadOlder = useCallback(
    async function loadOlder(): Promise<void> {
      const cursor = olderCursor.current;
      if (cursor === null || loadingOlder) {
        return;
      }
      setLoadingOlder(true);
      try {
        const page = (await handle.timeline.refetch({
          direction: "before",
          cursor: cursor as never,
          limit: OLDER_LIMIT,
          projection: "projected",
        })) as unknown as PageLike;
        if (!alive.current) {
          return;
        }
        if (page.error) {
          setError(messageOf(page.error));
        } else {
          commit(prependOlder(stateRef.current, page.entries ?? []));
          olderCursor.current = page.startCursor ?? null;
          setHasOlder(page.hasOlder === true && page.startCursor != null);
        }
      } catch (caught) {
        if (alive.current) {
          setError(messageOf(caught));
        }
      } finally {
        if (alive.current) {
          setLoadingOlder(false);
        }
      }
    },
    [handle, loadingOlder, commit],
  );

  // Initial load + live subscriptions.
  useEffect(
    function attach() {
      alive.current = true;
      stateRef.current = EMPTY_STATE;
      setState(EMPTY_STATE);
      setAgent(NO_AGENT);
      setLoading(true);
      setError(null);
      setHasOlder(false);
      olderCursor.current = null;
      fetching.current = false;
      queued.current = false;
      void reload();
      void refreshAgent();

      const timeline = handle.timeline.subscribe(function onEvent(event) {
        lastEventAt.current = Date.now();
        const type = (event as { event?: { type?: string } }).event?.type;
        if (type === "replacement" || type === "subscription_restored") {
          void reload();
          return;
        }
        if (type === "error") {
          return;
        }
        const merged = mergeStreamEvent(stateRef.current, event as unknown as StreamPayload);
        if (merged.refetch) {
          void reload();
        } else if (merged.changed) {
          commit(merged.state);
        }
        // Stream events carry turn/permission transitions; re-read the snapshot.
        setAgent(readAgent(handle));
      });
      timeline.ready.catch(function ignore() {
        // The safety-net refetch still keeps the view fresh.
      });
      const unsubscribeAgent = handle.subscribe(function onUpdate() {
        if (alive.current) {
          setAgent(readAgent(handle));
        }
      });
      return function detach() {
        alive.current = false;
        timeline();
        unsubscribeAgent();
      };
    },
    [handle, reload, refreshAgent, commit],
  );

  // Safety net while running: refetch the tail when the stream has been quiet.
  const running = agent.running;
  useEffect(
    function safetyNet() {
      if (!running) {
        return undefined;
      }
      const timer = setInterval(function tick() {
        if (Date.now() - lastEventAt.current >= SAFETY_NET_MS) {
          void reload();
          void refreshAgent();
        }
      }, SAFETY_NET_MS);
      return function stop() {
        clearInterval(timer);
      };
    },
    [running, reload, refreshAgent],
  );

  // One final refetch when a turn ends so the tail is complete.
  const wasRunning = useRef(false);
  useEffect(
    function settle() {
      if (wasRunning.current && !running) {
        void reload();
      }
      wasRunning.current = running;
    },
    [running, reload],
  );

  return {
    handle,
    state,
    agent,
    loading,
    error,
    hasOlder,
    loadingOlder,
    loadOlder,
    reload,
    refreshAgent,
  };
}
