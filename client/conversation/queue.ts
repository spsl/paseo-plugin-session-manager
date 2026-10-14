/**
 * Per-session composer queue. Entries are delivered one at a time by the
 * queue drain (sendNext) once the agent transitions to idle — there is no
 * "delete" entry point, only edit (take + put back into the draft) and
 * immediate send (take + send), mirroring Paseo.
 */
import { useSyncExternalStore } from "react";
import type { ComposerImage } from "./composer-images";

export type QueuedMessage = {
  id: string;
  text: string;
  images: readonly ComposerImage[];
};

const queues = new Map<string, QueuedMessage[]>();
const listeners = new Set<(sessionId: string) => void>();
const EMPTY: readonly QueuedMessage[] = [];
let nextId = 1;

function emit(sessionId: string): void {
  for (const listener of listeners) {
    listener(sessionId);
  }
}

export function enqueueMessage(
  sessionId: string,
  input: { text: string; images: readonly ComposerImage[] },
): QueuedMessage {
  const message: QueuedMessage = { id: `q${nextId++}`, text: input.text, images: input.images };
  // Immutable updates: useSyncExternalStore compares snapshots by reference.
  queues.set(sessionId, [...(queues.get(sessionId) ?? []), message]);
  emit(sessionId);
  return message;
}

/** Removes and returns the entry, or null when it no longer exists. */
export function takeQueuedMessage(sessionId: string, id: string): QueuedMessage | null {
  const list = queues.get(sessionId);
  const index =
    list === undefined
      ? -1
      : list.findIndex(function byId(m) {
          return m.id === id;
        });
  if (index < 0 || list === undefined) {
    return null;
  }
  const message = list[index];
  queues.set(
    sessionId,
    list.filter(function keep(candidate) {
      return candidate !== message;
    }),
  );
  emit(sessionId);
  return message;
}

/** Puts a message back at the head after a failed send attempt. */
export function requeueFront(sessionId: string, message: QueuedMessage): void {
  queues.set(sessionId, [message, ...(queues.get(sessionId) ?? [])]);
  emit(sessionId);
}

/** Drops a session's queue entirely — used when the agent is archived. */
export function clearQueue(sessionId: string): void {
  if (queues.delete(sessionId)) {
    emit(sessionId);
  }
}

export function queueFor(sessionId: string): readonly QueuedMessage[] {
  return queues.get(sessionId) ?? EMPTY;
}

/** Session ids holding at least one queued entry (drain watches these). */
export function queuedSessionIds(): string[] {
  const ids: string[] = [];
  for (const [id, list] of queues) {
    if (list.length > 0) {
      ids.push(id);
    }
  }
  return ids;
}

export function subscribeQueue(listener: (sessionId: string) => void): () => void {
  listeners.add(listener);
  return function unsubscribe() {
    listeners.delete(listener);
  };
}

export function useQueuedMessages(sessionId: string): readonly QueuedMessage[] {
  return useSyncExternalStore(subscribeQueue, function getSnapshot() {
    return queueFor(sessionId);
  });
}
