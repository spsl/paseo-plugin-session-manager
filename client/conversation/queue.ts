/**
 * Per-session composer queue: messages typed while the agent is mid-turn wait
 * here and are sent one by one once the turn ends. Module-level so the queue
 * survives closing and reopening the session pane; it is client-side only, so
 * a restart drops it.
 * Synchronous listeners only (Hermes); no async arrows.
 */
import { useSyncExternalStore } from "react";

export type QueuedMessage = { id: string; text: string };

const queues = new Map<string, QueuedMessage[]>();
const listeners = new Set<(sessionId: string) => void>();
let counter = 0;
const EMPTY: readonly QueuedMessage[] = [];

function notify(sessionId: string): void {
  const snapshot = [...listeners];
  for (const listener of snapshot) {
    listener(sessionId);
  }
}

export function queueFor(sessionId: string): readonly QueuedMessage[] {
  return queues.get(sessionId) ?? EMPTY;
}

export function enqueueMessage(sessionId: string, text: string): QueuedMessage {
  counter += 1;
  const message: QueuedMessage = { id: `q${counter}`, text };
  queues.set(sessionId, [...queueFor(sessionId), message]);
  notify(sessionId);
  return message;
}

export function removeQueuedMessage(sessionId: string, id: string): QueuedMessage | null {
  const queue = queueFor(sessionId);
  const index = queue.findIndex(function match(message) {
    return message.id === id;
  });
  if (index < 0) {
    return null;
  }
  const next = queue.slice();
  const removed = next.splice(index, 1)[0] ?? null;
  queues.set(sessionId, next);
  notify(sessionId);
  return removed;
}

/** Moves a queued message back into the draft for editing. */
export function popQueuedMessage(sessionId: string, id: string): string | null {
  const removed = removeQueuedMessage(sessionId, id);
  return removed === null ? null : removed.text;
}

export function subscribeQueue(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return function unsubscribe() {
    listeners.delete(listener);
  };
}

export function useQueuedMessages(sessionId: string): readonly QueuedMessage[] {
  return useSyncExternalStore(
    function subscribe(onStoreChange: () => void) {
      return subscribeQueue(function onQueue(changedId) {
        if (changedId === sessionId) {
          onStoreChange();
        }
      });
    },
    function snapshot() {
      return queueFor(sessionId);
    },
  );
}
