/**
 * Queue drain, mirroring Paseo: a queued session sends exactly one message
 * each time a running agent is observed stopped, or when a pane nudges after
 * loading an idle timeline ("synced-idle"). Automatic send failures put the
 * item back at the queue head and only console.warn — no UI error, and no
 * retry until the agent runs and stops again or another nudge arrives.
 *
 * One `watchAgents` observation is shared by every queued session and by both
 * pane instances; sends are deduped through a module-level in-flight set.
 * Agent updates are debounced 200ms; while any queue is non-empty the snapshot
 * is also refreshed every 3s, which only patches missed transitions and never
 * sends on its own while the agent stays idle.
 * No async arrow functions, no closures inside for...of (Hermes).
 */
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { watchAgents } from "../agents-watch";
import { imagesOption } from "./composer-images";
import { clearQueue, queueFor, queuedSessionIds, requeueFront, takeQueuedMessage } from "./queue";

type Paseo = PluginClientContext["paseo"];
type AgentHandle = ReturnType<Paseo["agents"]["ref"]>;
export type DrainTrigger = "stopped" | "synced-idle";

type Snapshot = { status: string | null; activeTurn: unknown };

const UPDATE_DEBOUNCE_MS = 200;
const REFRESH_MS = 3_000;

type DrainRecord = {
  handle: AgentHandle;
  lastRunning: boolean | undefined;
};

const records = new Map<string, DrainRecord>();
const pendingArmed = new Set<string>();
const inflight = new Set<string>();
let paseoRef: Paseo | null = null;
let unwatch: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let updateTimer: ReturnType<typeof setTimeout> | null = null;

/** Running means the daemon reports running/initializing or a live turn. */
export function isRunning(s: Snapshot): boolean {
  return s.status === "running" || s.status === "initializing" || s.activeTurn != null;
}

/**
 * Pure trigger rule: only a previously-running agent that is not running now
 * drains. Always-idle and not-yet-observed states return null.
 */
export function drainTrigger(
  prevRunning: boolean | undefined,
  s: Snapshot,
): DrainTrigger | null {
  if (prevRunning !== true || isRunning(s)) {
    return null;
  }
  return "stopped";
}

function snapshotOf(handle: AgentHandle): Snapshot {
  return { status: handle.status ?? null, activeTurn: handle.activeTurn };
}

function recordFor(sessionId: string): DrainRecord | null {
  const paseo = paseoRef;
  if (paseo === null) {
    return null;
  }
  let record = records.get(sessionId);
  if (record === undefined) {
    record = {
      handle: paseo.agents.ref(sessionId),
      lastRunning: pendingArmed.delete(sessionId) ? true : undefined,
    };
    records.set(sessionId, record);
  }
  return record;
}

async function refreshRecord(record: DrainRecord): Promise<Snapshot | null> {
  try {
    await record.handle.refresh();
  } catch {
    return null;
  }
  return snapshotOf(record.handle);
}

/** An archived session's queue is dead weight: drop it and stop watching. */
function dropArchivedQueue(sessionId: string): void {
  clearQueue(sessionId);
  if (queuedSessionIds().length === 0) {
    release();
  }
}

async function observeAndDrain(sessionId: string): Promise<void> {
  const record = recordFor(sessionId);
  if (record === null) {
    return;
  }
  const snap = await refreshRecord(record);
  const current = records.get(sessionId);
  if (snap === null || current === undefined) {
    return;
  }
  if (current.handle.archivedAt != null) {
    // The daemon unarchives on send; never resurrect a session the user
    // archived (archiving also stops the agent, which looks like a trigger).
    dropArchivedQueue(sessionId);
    return;
  }
  const trigger = drainTrigger(current.lastRunning, snap);
  current.lastRunning = isRunning(snap);
  if (trigger !== null) {
    void sendNext(sessionId);
  }
}

function sweep(): void {
  const ids = queuedSessionIds();
  if (ids.length === 0) {
    release();
    return;
  }
  const live = new Set(ids);
  for (const id of records.keys()) {
    if (!live.has(id)) {
      records.delete(id);
    }
  }
  ids.forEach(function check(id) {
    void observeAndDrain(id);
  });
}

function onAgentsUpdate(): void {
  if (updateTimer !== null) {
    return;
  }
  updateTimer = setTimeout(function run() {
    updateTimer = null;
    sweep();
  }, UPDATE_DEBOUNCE_MS);
}

function release(): void {
  if (unwatch !== null) {
    unwatch();
    unwatch = null;
  }
  if (refreshTimer !== null) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  if (updateTimer !== null) {
    clearTimeout(updateTimer);
    updateTimer = null;
  }
  records.clear();
}

/**
 * Idempotent: opens the shared agent observation while any queue holds an
 * entry; releases it once every queue is empty.
 */
export function ensureQueueDrain(paseo: Paseo): void {
  paseoRef = paseo;
  if (queuedSessionIds().length === 0) {
    release();
    return;
  }
  if (unwatch === null) {
    unwatch = watchAgents(paseo, onAgentsUpdate);
    refreshTimer = setInterval(sweep, REFRESH_MS);
  }
}

/**
 * Called right after enqueueing while the agent is running: records the
 * previous observation as running so the next idle observation drains.
 */
export function markQueuedWhileRunning(sessionId: string): void {
  const record = records.get(sessionId);
  if (record !== undefined) {
    record.lastRunning = true;
  } else {
    pendingArmed.add(sessionId);
  }
}

/** Pane-driven "synced-idle" trigger: send the head if the agent is idle. */
export function nudgeQueueDrain(sessionId: string): void {
  void sendNext(sessionId);
}

async function sendNext(sessionId: string): Promise<void> {
  if (inflight.has(sessionId)) {
    return;
  }
  const record = recordFor(sessionId);
  if (record === null) {
    return;
  }
  inflight.add(sessionId);
  try {
    const snap = await refreshRecord(record);
    if (snap === null) {
      return;
    }
    record.lastRunning = isRunning(snap);
    if (isRunning(snap)) {
      return;
    }
    if (record.handle.archivedAt != null) {
      dropArchivedQueue(sessionId);
      return;
    }
    const head = queueFor(sessionId)[0];
    if (head === undefined) {
      return;
    }
    const message = takeQueuedMessage(sessionId, head.id);
    if (message === null) {
      return;
    }
    try {
      await record.handle.send(message.text, {
        activeTurnBehavior: "steer",
        ...imagesOption(message.images),
      });
      // The daemon's send reply only lands after the run has started, so the
      // agent is running now — even when its whole turn fits inside one
      // debounce window and the next observation is already idle.
      record.lastRunning = true;
    } catch (error) {
      requeueFront(sessionId, message);
      console.warn("[session-manager] 排队消息发送失败", error);
    }
  } finally {
    inflight.delete(sessionId);
    if (queuedSessionIds().length === 0) {
      release();
    }
  }
}
