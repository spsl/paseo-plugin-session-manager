import {
  normalizeAnalysisConfig,
  type AnalysisConfig,
} from "../shared/analysis-config";
import { isExcludedAgent, parseExclusions, type AgentExclusion } from "../shared/agent-filter";
import type { AnalyzerSettings } from "../shared/settings";
import {
  DECLARED_KIND_LABELS,
  isActiveLiveness,
  type Analysis,
  type AnalysisRun,
  type AnalysisRunOutcome,
  type Declared,
  type AnalysisStatus,
  type FlowChild,
  type FlowTurn,
  type SessionDetail,
  type SessionView,
  type Turn,
} from "../shared/types";
import { COLUMNS } from "../shared/presentation";
import { CliAnalyzer, DEFAULT_ANALYZER_TIMEOUT_MS, type Analyzer } from "./analyzer/analyzer";
import { MagpieAnalyzer } from "./analyzer/magpie";
import type { MagpieRunConfig } from "./analyzer/magpie";
import { newTurnIds, type AnalyzerInput, type AnalyzerTurnDigest } from "./analyzer/prompt";
import { buildFlow, type FlowTurnInput } from "./flow";
import type { DigestStore, NewAnalysisRun } from "./digest-store";
import { gitHeadOf, resolveAnalyzerBinary } from "./cli";
import { reloadAgentViaCli } from "./agent-cli";
import type {
  AgentListEntry,
  ArchivedEvent,
  ClosedEvent,
  CreatedEvent,
  HookAgent,
  PaseoApi,
  PermissionRequestedEvent,
  PermissionResolvedEvent,
  TurnEndedEvent,
  TurnStartedEvent,
} from "./host-types";
import { applyAgentSnapshot, applyHookAgent, applyLabels, newRecord } from "./lifecycle";
import { projectDetail, projectView } from "./projection";
import {
  MAX_REVIEWERS,
  MAX_TURNS_PER_SESSION,
  copyRecord,
  withTurnHistory,
  type SessionRecord,
  type StateStore,
} from "./store";
import {
  REVIEW_LABEL,
  renderReviewPrompt,
  reviewEligibility,
  reviewInProgress,
  reviewRequestBlock,
  reviewTurnVerifies,
  reviewerFinished,
  type ReviewLookup,
} from "./review";
import { decideTitleWrite, writeTitleViaCli } from "./title-writeback";
import { interruptedTeamGroups, teamRecoveryMessage, type TeamRecoveryGroup } from "./team-recovery";
import {
  firstUserMessageFrom,
  stableTextHash,
  timelineCursorOf,
  turnFromTurnEnded,
  turnStartFromCursor,
  turnsFromTimelineEntries,
} from "./turns";
import { normalizeTitle } from "../shared/types";
import { sessionDisplayName } from "../shared/card";
import type { Notifier, NotifyAgent } from "./notifier";

const RECONCILE_INTERVAL_MS = 5_000;
const RECONCILE_WAIT_CAP_MS = 4_000;
const RECONCILE_PAGE_LIMIT = 200;
const RECONCILE_MAX_PAGES = 3;
const SEED_MAX_AGENTS = 50;
const SEED_TIMELINE_LIMIT = 300;
const PROBLEM_CACHE_MS = 30_000;
const DAY_MS = 86_400_000;
const MAX_TRACKED_GATES = 300;
/** agent.closed within this window of shutdown is treated as restart-caused. */
const SHUTDOWN_CLOSE_WINDOW_MS = 30_000;
const RESUME_CONCURRENCY = 3;
const RESUME_TIMEOUT_MS = 60_000;
const RESUME_TIMEOUT_TEXT = "恢复超时（60 秒）";
const REOPEN_TIMEOUT_TEXT = "重新打开超时（60 秒）";
const TEAM_NOTIFY_TIMEOUT_MS = 30_000;
const REVIEW_SEND_TIMEOUT_MS = 30_000;
/** Another plugin's helper agents are never carded or announced, whatever the board setting says. */
const NEVER_NOTIFY = parseExclusions("herald.role");

type CardTurn = { turnId: string; gate: Promise<boolean> };

export type SettingsProvider = {
  /** Last known settings (defaults when unreadable); synchronous. */
  current(): AnalyzerSettings;
  refresh(): Promise<AnalyzerSettings>;
};

export type ServiceDeps = {
  store: StateStore;
  analyzer?: Analyzer;
  settings: SettingsProvider;
  writeTitle?: (agentId: string, title: string) => Promise<void>;
  /** Returns a human-readable problem with the analyzer setup, or null. */
  checkAnalyzer?: (config: AnalysisConfig, command: string) => Promise<string | null>;
  now?: () => number;
  /** `git rev-parse HEAD` for the review baseline; injectable for tests. */
  headOf?: (cwd: string) => Promise<string | null>;
  /** Cards and announcements; absent means none are produced. */
  notifier?: Notifier;
  /** history.db per-turn digests; absent or disabled keeps everything working. */
  digests?: DigestStore;
  /** `paseo agent reload` for archived sessions; injectable for tests. */
  reloadAgentCli?: (agentId: string) => Promise<MutationResult>;
};

export type MutationResult = { ok: boolean; reason?: string };

export type SnapshotResult = {
  generatedAt: number;
  sessions: SessionView[];
  analyzer: {
    enabled: boolean;
    agent: AnalysisConfig["agent"];
    model: string;
    problem: string | null;
  };
  seeding: boolean;
};

export function describeAnalysisError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 320) || "分析失败";
}

async function defaultCheckAnalyzer(config: AnalysisConfig, command: string): Promise<string | null> {
  if (config.agent === "magpie") {
    // The direct adapter has no binary to find; its own request surfaces problems.
    return null;
  }
  try {
    await resolveAnalyzerBinary(config.agent, command);
    return null;
  } catch (error) {
    return describeAnalysisError(error);
  }
}

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class SessionManagerService {
  private readonly records = new Map<string, SessionRecord>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly running = new Set<string>();
  private readonly analyzer: Analyzer;
  private readonly magpieAnalyzer: MagpieAnalyzer;
  private readonly now: () => number;
  private paseo: PaseoApi | null = null;
  private reconcileInFlight: Promise<void> | null = null;
  private lastReconcileAt = 0;
  /** True once the first successful agents.list pass ran since startup. */
  private reconciledOnce = false;
  private loadDone = false;
  /** The startup load; reconcile waits for it so persisted state is never shadowed. */
  private loading: Promise<unknown> | null = null;
  private seedStarted = false;
  private seeding = false;
  private stopped = false;
  /** agent.closed seen recently; prepareShutdown turns the active ones dormant. */
  private readonly recentClosures = new Map<
    string,
    { at: number; wasActive: boolean; interrupted: boolean }
  >();
  private readonly resumeTasks = new Map<string, Promise<MutationResult>>();
  private autoResumeStarted = false;
  private autoResumeDone: Promise<void> | null = null;
  private problemCache: { key: string; at: number; value: string | null } | null = null;
  private readonly idleWaiters: Array<() => void> = [];
  private readonly labelProbes = new Map<string, Promise<void>>();
  private exclusionCache: { text: string; rules: AgentExclusion[] } | null = null;
  /** The turn per agent whose pending card is on screen, with the check that allows cards for it. */
  private readonly cardTurns = new Map<string, CardTurn>();
  private readonly requestGates = new Map<string, Promise<boolean>>();

  constructor(private readonly deps: ServiceDeps) {
    this.analyzer = deps.analyzer ?? new CliAnalyzer();
    this.magpieAnalyzer = new MagpieAnalyzer();
    this.now = deps.now ?? Date.now;
  }

  /** Magpie talks HTTP, so it never goes through the CLI analyzer. */
  private analyzerFor(agent: AnalysisConfig["agent"]): Analyzer | MagpieAnalyzer {
    return agent === "magpie" ? this.magpieAnalyzer : this.analyzer;
  }

  // ---- lifecycle -------------------------------------------------------

  /** Merges persisted records (never overwriting live ones) and re-queues pending work. */
  restore(restored: readonly SessionRecord[]): number {
    let count = 0;
    for (const record of restored) {
      if (this.records.has(record.id)) {
        continue;
      }
      this.records.set(record.id, record);
      count += 1;
      if (record.analysisState === "queued") {
        if (record.turns.length > 0) {
          this.enqueue(record.id);
        } else {
          record.analysisState = "awaiting_output";
        }
      }
    }
    return count;
  }

  load(): Promise<number> {
    const pending = this.loadRecords();
    this.loading = pending;
    return pending;
  }

  private async loadRecords(): Promise<number> {
    const restored = await this.deps.store.load();
    const count = this.restore(restored);
    // history.db rows outlive state.json records; drop sessions the state lost.
    // Skipped on an empty load: an unreadable or missing state.json must never
    // wipe the digest store, which keeps its own longer-lived history.
    if (restored.length > 0) {
      this.deps.digests?.pruneOrphans(new Set(this.records.keys()));
    }
    if (count > 0) {
      this.persist();
    }
    this.loadDone = true;
    return count;
  }

  stop(): void {
    this.stopped = true;
  }

  touchPaseo(paseo: PaseoApi): void {
    this.paseo = paseo;
  }

  /** Fresh settings for RPCs that must not run on a stale cache. */
  async currentAnalyzerSettings(): Promise<AnalyzerSettings> {
    return this.deps.settings.refresh();
  }

  /** Called when settings change: queued work may now be runnable. */
  settingsChanged(): void {
    this.pruneExcluded();
    if (!this.deps.settings.current().enabled) {
      for (const [id, entry] of [...this.cardTurns]) {
        this.finishTurnCard(id, entry.turnId, "failed", "自动分析已关闭");
      }
    }
    this.drain();
  }

  size(): number {
    return this.records.size;
  }

  getRecord(id: string): SessionRecord | undefined {
    return this.records.get(id);
  }

  // ---- event handlers (synchronous) ------------------------------------

  private ensure(agent: HookAgent): SessionRecord {
    let record = this.records.get(agent.id);
    if (record) {
      applyHookAgent(record, agent);
    } else {
      record = newRecord(agent, this.now());
      this.records.set(record.id, record);
      void this.probeLabels(record.id);
    }
    return record;
  }

  // ---- agent exclusion (other plugins' helper agents) --------------------

  private exclusions(): AgentExclusion[] {
    const text = this.deps.settings.current().excludedLabelKeys ?? "";
    if (!this.exclusionCache || this.exclusionCache.text !== text) {
      this.exclusionCache = { text, rules: parseExclusions(text) };
    }
    return this.exclusionCache.rules;
  }

  private isExcludedRecord(record: SessionRecord): boolean {
    return record.labelsKnown && isExcludedAgent(record.labels, this.exclusions());
  }

  // ---- cards and announcements (best-effort, never block hooks) ----------

  /** Whether cards may be produced for this agent: labels known and not another plugin's helper. */
  private cardsAllowed(id: string): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      try {
        const record = this.records.get(id);
        if (!record) {
          return false;
        }
        if (!record.labelsKnown) {
          await this.probeLabels(id);
        }
        const fresh = this.records.get(id);
        return (
          fresh !== undefined &&
          fresh.labelsKnown &&
          !isExcludedAgent(fresh.labels, NEVER_NOTIFY) &&
          !this.isExcludedRecord(fresh)
        );
      } catch {
        return false;
      }
    };
    return run();
  }

  private notifyAgent(record: SessionRecord): NotifyAgent {
    return {
      id: record.id,
      parentAgentId: record.parentAgentId,
      name: sessionDisplayName({
        agentTitle: record.agentTitle,
        analysisTitle: record.analysis?.title ?? null,
        cwd: record.cwd,
      }),
    };
  }

  private beginTurnCard(record: SessionRecord, turnId: string): void {
    const notifier = this.deps.notifier;
    if (!notifier || !this.deps.settings.current().enabled) {
      return;
    }
    const previous = this.cardTurns.get(record.id);
    if (previous && previous.turnId !== turnId) {
      this.finishTurnCard(record.id, previous.turnId, "superseded");
    }
    const gate = this.cardsAllowed(record.id);
    this.cardTurns.set(record.id, { turnId, gate });
    const id = record.id;
    void gate.then((ok) => {
      const paseo = this.paseo;
      const current = this.records.get(id);
      if (ok && paseo && current) {
        return notifier.turnPending(paseo, this.notifyAgent(current), turnId);
      }
      return undefined;
    });
  }

  /** Ends the pending card of `turnId` (if one was shown) with a final state. */
  private finishTurnCard(
    id: string,
    turnId: string,
    outcome:
      | "superseded"
      | "failed"
      | { analysis: Analysis; turnOutcome: Turn["outcome"]; declared: Declared | null },
    error?: string,
  ): void {
    const notifier = this.deps.notifier;
    const entry = this.cardTurns.get(id);
    if (!notifier || !entry || entry.turnId !== turnId) {
      return;
    }
    this.cardTurns.delete(id);
    void entry.gate.then((ok) => {
      const paseo = this.paseo;
      const record = this.records.get(id);
      if (!ok || !paseo || !record) {
        return undefined;
      }
      const agent = this.notifyAgent(record);
      if (outcome === "superseded") {
        return notifier.turnSuperseded(paseo, agent, turnId);
      }
      if (outcome === "failed") {
        return notifier.turnFailed(paseo, agent, turnId, error ?? "分析失败");
      }
      return notifier.turnReady(
        paseo,
        agent,
        turnId,
        outcome.analysis,
        outcome.turnOutcome,
        outcome.declared,
      );
    });
  }

  private removeRecord(id: string): void {
    this.records.delete(id);
    this.deps.digests?.removeSession(id);
    this.queued.delete(id);
    const index = this.queue.indexOf(id);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
    this.persist();
  }

  private pruneExcluded(): void {
    for (const record of [...this.records.values()]) {
      if (this.isExcludedRecord(record)) {
        this.removeRecord(record.id);
      }
    }
  }

  /** Learns an agent's labels in the background (hooks carry none); drops it when excluded. */
  private probeLabels(id: string): Promise<void> {
    const paseo = this.paseo;
    const existing = this.labelProbes.get(id);
    if (existing) {
      return existing;
    }
    const record = this.records.get(id);
    if (!paseo || !record || record.labelsKnown) {
      return Promise.resolve();
    }
    const probe = this.fetchLabels(paseo, id).finally(() => {
      this.labelProbes.delete(id);
    });
    this.labelProbes.set(id, probe);
    return probe;
  }

  private async fetchLabels(paseo: PaseoApi, id: string): Promise<void> {
    try {
      const fresh = await paseo.agents.ref(id).refresh();
      const record = this.records.get(id);
      if (!fresh || !record) {
        return;
      }
      if (fresh.agent.labels) {
        applyLabels(record, fresh.agent.labels);
      }
      this.pruneReviewerLabels(record);
      if (this.isExcludedRecord(record)) {
        this.removeRecord(id);
      } else {
        this.persist();
      }
    } catch {
      // Labels stay unknown; reconcile will fill them in.
    }
  }

  /** A child labeled for another review leaves an open review's reviewerIds. */
  private pruneReviewerLabels(record: SessionRecord): void {
    const tagged = record.labels[REVIEW_LABEL];
    if (tagged === undefined) {
      return;
    }
    let changed = false;
    for (const parent of this.records.values()) {
      const review = parent.review;
      if (!review || review.closedAt !== null) {
        continue;
      }
      const index = review.reviewerIds.indexOf(record.id);
      if (index >= 0 && tagged !== review.id) {
        review.reviewerIds.splice(index, 1);
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  onCreated(event: CreatedEvent): void {
    const record = this.ensure(event.agent);
    record.liveness = "live";
    record.updatedAt = this.now();
    // A child created while its parent's review is open counts as a reviewer.
    const parentId = record.parentAgentId;
    if (parentId && parentId !== record.id) {
      const review = this.records.get(parentId)?.review;
      if (
        review &&
        review.closedAt === null &&
        review.error === null &&
        !review.reviewerIds.includes(record.id) &&
        review.reviewerIds.length < MAX_REVIEWERS
      ) {
        review.reviewerIds.push(record.id);
      }
    }
    this.persist();
  }

  onTurnStarted(event: TurnStartedEvent): void {
    const record = this.ensure(event.agent);
    record.liveness = "live";
    record.lifecycle = "working";
    // A new turn means the restart interruption is being worked through.
    record.interruptedAt = null;
    record.resumeState = "idle";
    record.resumeError = null;
    // A reply after the verdict closes the review; a still-running reviewer
    // (e.g. a second profile) keeps it open.
    const review = record.review;
    if (
      review &&
      review.closedAt === null &&
      review.verifiedTurnId !== null &&
      review.reviewerIds.every((id) => reviewerFinished(this.records.get(id)))
    ) {
      review.closedAt = this.now();
    }
    record.updatedAt = this.now();
    this.persist();
  }

  onPermissionRequested(event: PermissionRequestedEvent): void {
    const record = this.ensure(event.agent);
    record.pendingPermissionCount += 1;
    record.lifecycle = "waiting_permission";
    record.attentionReason = "permission";
    record.updatedAt = this.now();
    this.persist();
    this.notifyPermissionRequested(record, event);
  }

  private notifyPermissionRequested(record: SessionRecord, event: PermissionRequestedEvent): void {
    const notifier = this.deps.notifier;
    if (!notifier) {
      return;
    }
    const gate = this.cardsAllowed(record.id);
    this.requestGates.set(event.request.id, gate);
    if (this.requestGates.size > MAX_TRACKED_GATES) {
      const oldest = this.requestGates.keys().next();
      if (!oldest.done) {
        this.requestGates.delete(oldest.value);
      }
    }
    const id = record.id;
    void gate.then((ok) => {
      const paseo = this.paseo;
      const current = this.records.get(id);
      if (ok && paseo && current) {
        return notifier.permissionRequested(paseo, this.notifyAgent(current), event.request);
      }
      return undefined;
    });
  }

  private notifyPermissionResolved(record: SessionRecord, event: PermissionResolvedEvent): void {
    const notifier = this.deps.notifier;
    const gate = this.requestGates.get(event.requestId);
    if (!notifier || !gate) {
      return;
    }
    this.requestGates.delete(event.requestId);
    const id = record.id;
    void gate.then((ok) => {
      const paseo = this.paseo;
      const current = this.records.get(id);
      if (ok && paseo && current) {
        return notifier.permissionResolved(
          paseo,
          this.notifyAgent(current),
          event.requestId,
          event.resolution.behavior,
        );
      }
      return undefined;
    });
  }

  onPermissionResolved(event: PermissionResolvedEvent): void {
    const record = this.ensure(event.agent);
    record.pendingPermissionCount = Math.max(0, record.pendingPermissionCount - 1);
    if (record.pendingPermissionCount === 0) {
      if (record.attentionReason === "permission") {
        record.attentionReason = null;
      }
      if (record.lifecycle === "waiting_permission") {
        record.lifecycle = "working";
      }
    }
    record.updatedAt = this.now();
    this.persist();
    this.notifyPermissionResolved(record, event);
  }

  onTurnEnded(event: TurnEndedEvent): void {
    const record = this.ensure(event.agent);
    const now = this.now();
    record.updatedAt = now;
    record.liveness = record.liveness === "archived" ? "archived" : "live";
    record.lifecycle = event.outcome.kind === "failed" ? "error" : "idle";
    record.interruptedAt = null;
    record.resumeState = "idle";
    record.resumeError = null;
    record.pendingPermissionCount = 0;
    if (record.attentionReason === "permission") {
      record.attentionReason = null;
    }
    if (!record.firstUserMessageKnown) {
      const first = firstUserMessageFrom(event.timeline);
      if (first) {
        record.firstUserMessage = first;
        record.firstUserMessageKnown = true;
      }
    }
    const ended = turnFromTurnEnded(
      event.timeline,
      event.outcome,
      event.turnId,
      now,
      turnStartFromCursor(record.timelineCursor, event.timeline),
    );
    // Items already in the timeline belong to turns that have ended; even a
    // canceled or empty turn still advances the boundary for the next one.
    record.timelineCursor = timelineCursorOf(event.timeline);
    if (!ended) {
      this.persist();
      return;
    }
    const { turn, subAgents } = ended;
    const lastTurn = record.turns.at(-1);
    const byId = record.turns.findIndex((candidate) => candidate.id === turn.id);
    let enqueue = false;
    let wrote = false;
    if (byId >= 0) {
      const existing = record.turns[byId];
      if (existing.dedupeKey !== turn.dedupeKey) {
        record.turns[byId] = { ...turn, completedAt: now };
        enqueue = byId === record.turns.length - 1;
        wrote = true;
      }
    } else if (lastTurn && lastTurn.dedupeKey === turn.dedupeKey) {
      // Same content under a different id: a repeated event, nothing to do.
    } else {
      record.turns.push(turn);
      record.turns = record.turns.slice(-MAX_TURNS_PER_SESSION);
      enqueue = true;
      wrote = true;
    }
    if (wrote) {
      const stored = byId >= 0 ? record.turns[byId] : turn;
      this.deps.digests?.upsertTurn(record.id, stored, subAgents, now);
    }
    if (enqueue) {
      record.completedAt = turn.completedAt;
      record.analysisError = null;
      record.analysisState = "queued";
      this.beginTurnCard(record, turn.id);
      this.enqueue(record.id);
    }
    this.markReviewTurn(record, turn);
    this.persist();
  }

  /**
   * A parent turn ended: when every reviewer has finished and this turn started
   * after them (or the reply itself carried the verdict line), record the verify.
   */
  private markReviewTurn(record: SessionRecord, turn: Turn): void {
    const review = record.review;
    if (!review || review.closedAt !== null || review.error !== null) {
      return;
    }
    if (review.verifiedTurnId === null) {
      if (reviewTurnVerifies(review, turn, this.reviewLookup())) {
        review.verifiedTurnId = turn.id;
        review.verdict = turn.reviewVerdict ?? null;
      }
    } else if (review.verdict === null && turn.reviewVerdict) {
      // A later reply can still carry the verdict line; keep the boundary turn.
      review.verdict = turn.reviewVerdict;
    }
  }

  onClosed(event: ClosedEvent): void {
    const record = this.ensure(event.agent);
    // Captured before the fields are cleared: prepareShutdown needs the state
    // the session had when the close arrived (a daemon shutdown closes all
    // loaded agents at once, indistinguishable from user closes otherwise).
    this.noteRecentClosure(record);
    if (record.liveness !== "archived") {
      record.liveness = "closed";
    }
    record.pendingPermissionCount = 0;
    record.updatedAt = this.now();
    this.persist();
  }

  private noteRecentClosure(record: SessionRecord): void {
    const now = this.now();
    this.recentClosures.set(record.id, {
      at: now,
      wasActive: isActiveLiveness(record.liveness),
      interrupted: record.lifecycle === "working" || record.pendingPermissionCount > 0,
    });
    for (const [id, entry] of this.recentClosures) {
      if (now - entry.at > SHUTDOWN_CLOSE_WINDOW_MS) {
        this.recentClosures.delete(id);
      }
    }
  }

  /**
   * Runs from the plugin cleanup, after the daemon's closeAllAgents hooks
   * landed: agents closed just now were shut down with Paseo, not by the
   * user, so they become dormant (resumable) instead of closed.
   */
  prepareShutdown(): void {
    const now = this.now();
    let changed = false;
    for (const [id, closure] of this.recentClosures) {
      if (now - closure.at > SHUTDOWN_CLOSE_WINDOW_MS || !closure.wasActive) {
        continue;
      }
      const record = this.records.get(id);
      if (!record || record.liveness !== "closed") {
        continue;
      }
      record.liveness = "dormant";
      if (closure.interrupted) {
        record.interruptedAt = closure.at;
      }
      changed = true;
    }
    this.recentClosures.clear();
    if (changed) {
      this.persist();
    }
  }

  onArchived(event: ArchivedEvent): void {
    const record = this.ensure(event.agent);
    record.liveness = "archived";
    const at = Date.parse(event.archivedAt);
    record.archivedAt = Number.isFinite(at) ? at : this.now();
    record.pendingPermissionCount = 0;
    record.deferredUntil = null;
    record.deferToQueue = false;
    record.updatedAt = this.now();
    this.persist();
  }

  // ---- analysis queue --------------------------------------------------

  private enqueue(id: string): void {
    if (this.queued.has(id)) {
      return;
    }
    this.queued.add(id);
    this.queue.push(id);
    this.drain();
  }

  private drain(): void {
    if (this.stopped) {
      return;
    }
    const settings = this.deps.settings.current();
    while (settings.enabled && this.running.size < settings.concurrency) {
      const index = this.queue.findIndex((candidate) => !this.running.has(candidate));
      if (index < 0) {
        break;
      }
      const [id] = this.queue.splice(index, 1);
      this.queued.delete(id);
      const record = this.records.get(id);
      if (!record || record.turns.length === 0) {
        continue;
      }
      if (record.liveness === "archived") {
        this.settleDropped(record);
        this.finishTurnCard(id, record.turns.at(-1)?.id ?? "", "failed", "会话已归档，已跳过分析");
        continue;
      }
      this.running.add(id);
      void this.runAnalysis(id).finally(() => {
        this.running.delete(id);
        this.drain();
        this.notifyIdle();
      });
    }
    this.notifyIdle();
  }

  private settleDropped(record: SessionRecord): void {
    if (record.analysisState === "queued" || record.analysisState === "running") {
      record.analysisState = record.analysis ? "ready" : "awaiting_output";
      this.persist();
    }
  }

  private buildInput(
    record: SessionRecord,
    targetTurnId: string,
    historyTurnId: string | null,
  ): AnalyzerInput {
    return {
      session: {
        id: record.id,
        provider: record.provider,
        model: record.model,
        cwd: record.cwd,
        branch: record.branch,
        agentTitle: record.agentTitle,
        pendingPermission: record.pendingPermissionCount > 0,
        firstUserMessage: record.firstUserMessage,
      },
      turns: record.turns.slice(-5).map((turn) => ({ ...turn })),
      digests: this.digestEntries(record.id),
      previousAnalysis: record.analysis ? copyRecord(record).analysis : null,
      history: record.history
        .filter((entry) => entry.turnId !== targetTurnId)
        .map((entry) => entry.text),
      historyTurnId,
    };
  }

  /** Stored digests of this session's turns, oldest first (history.db). */
  private digestEntries(sessionId: string): AnalyzerTurnDigest[] {
    const rows = this.deps.digests?.listTurns(sessionId) ?? [];
    const entries: AnalyzerTurnDigest[] = [];
    for (const row of rows) {
      if (row.digest === null) {
        continue;
      }
      entries.push({
        id: row.turnId,
        completedAt: row.completedAt,
        userInput: row.userInput,
        step: row.step,
        digest: row.digest,
      });
    }
    return entries;
  }

  private runConfig(): MagpieRunConfig & { command: string; timeoutMs: number } {
    const settings = this.deps.settings.current();
    const config = normalizeAnalysisConfig(settings);
    if (config.agent === "magpie") {
      return {
        ...config,
        command: "",
        timeoutMs: (settings.timeoutSeconds || DEFAULT_ANALYZER_TIMEOUT_MS / 1000) * 1000,
        baseUrl: settings.magpieBaseUrl.trim() || undefined,
        apiKey: settings.magpieApiKey,
        review: settings.reviewTrigger !== "off",
      };
    }
    return {
      ...config,
      command: settings.command,
      timeoutMs: (settings.timeoutSeconds || DEFAULT_ANALYZER_TIMEOUT_MS / 1000) * 1000,
      review: settings.reviewTrigger !== "off",
    };
  }

  private async runAnalysis(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) {
      return;
    }
    if (!record.labelsKnown) {
      await this.probeLabels(id);
    }
    if (this.records.get(id) !== record) {
      return;
    }
    if (this.isExcludedRecord(record)) {
      this.removeRecord(id);
      return;
    }
    const targetTurnId = record.turns.at(-1)?.id;
    if (!targetTurnId) {
      return;
    }
    // Reanalyzing a turn reuses its boundary, so the same turns count as new.
    // Once an analysis has landed, its turn stays the boundary for the next
    // run — a run that recorded no history (done=[]) must not re-mark the
    // already-digested turns as new.
    const reanalyzing = record.analyzedTurnId === targetTurnId;
    const historyTurnId =
      record.analyzedTurnId === null
        ? null
        : reanalyzing
          ? record.historyBaseTurnId
          : record.analyzedTurnId;
    record.analysisState = "running";
    record.analysisError = null;
    let result: Analysis | null = null;
    let failure: string | null = null;
    /** The boundary and content keys the input was built with — write-back filters on them. */
    let inputNewIds: ReadonlySet<string> = new Set();
    const inputDedupe = new Map<string, string>();
    // Every call lands in 分析记录, whatever becomes of its result.
    const run: Omit<NewAnalysisRun, "outcome" | "error" | "analysis"> = {
      turnId: targetTurnId,
      startedAt: this.now(),
      durationMs: 0,
      userInput: record.turns.at(-1)?.userInput ?? null,
      reanalysis: reanalyzing,
      agent: "",
      model: "",
      inputChars: 0,
      newTurns: 0,
      digestCount: 0,
    };
    try {
      const config = this.runConfig();
      run.agent = config.agent;
      run.model = config.model;
      const input = this.buildInput(record, targetTurnId, historyTurnId);
      inputNewIds = newTurnIds(input.turns, historyTurnId);
      for (const turn of input.turns) {
        inputDedupe.set(turn.id, turn.dedupeKey);
      }
      run.inputChars = JSON.stringify(input).length;
      run.newTurns = inputNewIds.size;
      run.digestCount = input.digests?.length ?? 0;
      console.debug(`[session-manager] analysis input chars=${run.inputChars} session=${id}`);
      result = await this.analyzerFor(config.agent).analyze(input, config);
    } catch (error) {
      failure = describeAnalysisError(error);
    }
    run.durationMs = this.now() - run.startedAt;
    const logRun = (outcome: AnalysisRunOutcome): void => {
      this.deps.digests?.recordRun(id, {
        ...run,
        outcome: result ? outcome : "failed",
        error: failure,
        analysis: result,
      });
    };
    const current = this.records.get(id);
    if (!current || current.turns.at(-1)?.id !== targetTurnId) {
      // A newer turn arrived: its card replaces this one. A removed session
      // logs nothing — its rows are already gone.
      if (current) {
        logRun("superseded");
      }
      this.finishTurnCard(id, targetTurnId, "superseded");
      return;
    }
    if (current.liveness === "archived") {
      logRun("discarded");
      this.settleDropped(current);
      current.analysisState = current.analysis ? "ready" : "awaiting_output";
      this.persist();
      this.finishTurnCard(id, targetTurnId, "failed", "会话已归档，已跳过分析");
      return;
    }
    logRun("applied");
    if (result) {
      const turn = current.turns.at(-1);
      // turnDigests only belongs in history.db: keeping it off record.analysis
      // avoids persisting it, pushing it to clients, and sending it back to the
      // model inside previousAnalysis.
      const { turnDigests, ...analysis } = result;
      current.analysis = analysis;
      current.analysisState = "ready";
      current.analysisError = null;
      current.analyzedTurnId = targetTurnId;
      current.history = withTurnHistory(
        current.history,
        targetTurnId,
        turn?.completedAt ?? this.now(),
        result.done,
      );
      current.historyBaseTurnId = historyTurnId;
      // Superseded results return early above, so these digests never describe
      // stale turns. Still drop entries for turns that were not sent as new,
      // and only write when the stored row still holds the analyzed content.
      for (const digest of turnDigests ?? []) {
        if (!inputNewIds.has(digest.turnId)) {
          continue;
        }
        const dedupeKey = inputDedupe.get(digest.turnId);
        if (dedupeKey === undefined) {
          continue;
        }
        this.deps.digests?.writeAnalysis(
          id,
          digest.turnId,
          dedupeKey,
          digest.step,
          digest.digest,
          this.now(),
        );
      }
      this.persist();
      this.finishTurnCard(id, targetTurnId, {
        analysis,
        turnOutcome: turn?.outcome ?? "completed",
        declared: turn?.declared ?? null,
      });
      void this.maybeWriteBackTitle(id, result.title);
      void this.maybeAutoReview(id, targetTurnId);
    } else {
      current.analysisState = "failed";
      current.analysisError = failure;
      this.persist();
      this.finishTurnCard(id, targetTurnId, "failed", failure ?? "分析失败");
    }
  }

  /** Resolves when no analysis is queued or running (tests). */
  async waitForIdle(): Promise<void> {
    const settings = this.deps.settings.current();
    const blocked = (): boolean =>
      this.running.size > 0 || (settings.enabled && this.queue.length > 0);
    while (blocked()) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }

  private notifyIdle(): void {
    const waiters = this.idleWaiters.splice(0);
    for (const waiter of waiters) {
      waiter();
    }
  }

  // ---- title write-back ------------------------------------------------

  private async writeTitle(record: SessionRecord, title: string): Promise<boolean> {
    // Record before spawning so the resulting agent update is recognized as ours.
    record.titleState.lastWritten = title;
    this.persist();
    try {
      await (this.deps.writeTitle ?? writeTitleViaCli)(record.id, title);
      record.titleState.lastWriteError = null;
      record.agentTitle = title;
      this.persist();
      return true;
    } catch (error) {
      record.titleState.lastWriteError = describeAnalysisError(error);
      this.persist();
      return false;
    }
  }

  private async freshTitle(record: SessionRecord): Promise<string | null> {
    if (!this.paseo) {
      return record.agentTitle;
    }
    try {
      const fresh = await this.paseo.agents.ref(record.id).refresh();
      if (fresh) {
        const title = fresh.agent.title?.trim() || null;
        record.agentTitle = title;
        return title;
      }
    } catch {
      // Fall back to the last known title.
    }
    return record.agentTitle;
  }

  async maybeWriteBackTitle(id: string, generated: string): Promise<void> {
    const settings = this.deps.settings.current();
    const record = this.records.get(id);
    const title = normalizeTitle(generated);
    if (!record || !title || !settings.writeBackTitle || record.titleState.userOwned) {
      return;
    }
    if (record.liveness !== "live") {
      return;
    }
    const currentTitle = await this.freshTitle(record);
    const decision = decideTitleWrite({
      enabled: settings.writeBackTitle,
      live: record.liveness === "live",
      userOwned: record.titleState.userOwned,
      currentTitle,
      generatedTitle: title,
      titleState: record.titleState,
      firstUserMessage: record.firstUserMessage,
    });
    if (decision === "mark_user_owned") {
      record.titleState.userOwned = true;
      this.persist();
    } else if (decision === "write") {
      await this.writeTitle(record, title);
    }
  }

  // ---- RPC operations ---------------------------------------------------

  reanalyze(id: string): MutationResult {
    const record = this.records.get(id);
    if (!record) {
      return { ok: false, reason: "会话不存在" };
    }
    if (record.turns.length === 0) {
      return { ok: false, reason: "暂无可分析的对话" };
    }
    if (record.analysisState === "running" || this.running.has(id)) {
      return { ok: false, reason: "正在分析中" };
    }
    if (!this.deps.settings.current().enabled) {
      return { ok: false, reason: "自动分析已关闭，请先在设置中启用" };
    }
    record.analysisError = null;
    record.analysisState = "queued";
    this.enqueue(id);
    this.persist();
    return { ok: true };
  }

  setManualStatus(id: string, status: AnalysisStatus): MutationResult {
    const record = this.records.get(id);
    if (!record) {
      return { ok: false, reason: "会话不存在" };
    }
    if (!isActiveLiveness(record.liveness)) {
      return { ok: false, reason: "会话已关闭，无法调整状态" };
    }
    record.manualStatusOverride = status;
    this.persist();
    return { ok: true };
  }

  clearManualStatus(id: string): MutationResult {
    const record = this.records.get(id);
    if (!record) {
      return { ok: false, reason: "会话不存在" };
    }
    record.manualStatusOverride = null;
    this.persist();
    return { ok: true };
  }

  defer(id: string, durationMs: number, toQueue: boolean): MutationResult {
    const record = this.records.get(id);
    if (!record) {
      return { ok: false, reason: "会话不存在" };
    }
    if (!isActiveLiveness(record.liveness)) {
      return { ok: false, reason: "会话已关闭，无法延迟显示" };
    }
    record.deferredUntil = this.now() + durationMs;
    record.deferToQueue = toQueue;
    this.persist();
    return { ok: true };
  }

  clearDefer(id: string): MutationResult {
    const record = this.records.get(id);
    if (!record) {
      return { ok: false, reason: "会话不存在" };
    }
    record.deferredUntil = null;
    record.deferToQueue = false;
    this.persist();
    return { ok: true };
  }

  async applyGeneratedTitle(id: string): Promise<MutationResult> {
    const record = this.records.get(id);
    if (!record) {
      return { ok: false, reason: "会话不存在" };
    }
    const title = normalizeTitle(record.analysis?.title);
    if (!title) {
      return { ok: false, reason: "尚无生成的标题" };
    }
    if (record.liveness === "archived") {
      return { ok: false, reason: "会话已归档，无法修改标题" };
    }
    record.titleState.userOwned = false;
    const ok = await this.writeTitle(record, title);
    return ok ? { ok: true } : { ok: false, reason: record.titleState.lastWriteError ?? "回写失败" };
  }

  forget(id: string): MutationResult {
    const record = this.records.get(id);
    if (!record) {
      return { ok: true };
    }
    if (record.liveness === "live") {
      return { ok: false, reason: "会话仍在运行，无法移除" };
    }
    this.records.delete(id);
    this.deps.digests?.removeSession(id);
    this.persist();
    return { ok: true };
  }

  // ---- code review --------------------------------------------------------

  private reviewLookup(): ReviewLookup {
    const records = this.records;
    return {
      get: (id) => records.get(id),
      all: () => records.values(),
      settings: this.deps.settings.current(),
    };
  }

  /** Deterministic request id; also the `session-manager.review` label value. */
  private reviewRequestId(record: SessionRecord, turnId: string): string {
    return `rv_${stableTextHash(`${record.id}\0${turnId}`)}`;
  }

  /** The rendered request text the edit dialog prefills. */
  previewReview(id: string): { text: string } {
    const record = this.records.get(id);
    const settings = this.deps.settings.current();
    const requestId = record
      ? this.reviewRequestId(record, record.turns.at(-1)?.id ?? "none")
      : "rv_preview";
    return {
      text: renderReviewPrompt(settings.reviewPrompt, {
        scope: settings.reviewScope,
        requestId,
        lastReviewHead: record?.lastReviewHead ?? null,
      }),
    };
  }

  /**
   * Appends the review request to the session via `steer`. `expectedTurnId` is
   * the auto trigger's snapshot of the latest turn: when the session moved on,
   * the request stays a suggestion instead of steering mid-turn.
   */
  async requestReview(
    id: string,
    text?: string,
    trigger: "auto" | "manual" = "manual",
    expectedTurnId?: string,
  ): Promise<MutationResult> {
    const record = this.records.get(id);
    if (!record) {
      return { ok: false, reason: "会话不存在" };
    }
    const block = reviewRequestBlock(record, this.records.values());
    if (block) {
      return { ok: false, reason: block };
    }
    const turnId = record.turns.at(-1)?.id;
    if (!turnId) {
      return { ok: false, reason: "暂无可审查的对话内容" };
    }
    if (expectedTurnId !== undefined && turnId !== expectedTurnId) {
      return { ok: false, reason: "会话已有新的进展" };
    }
    const paseo = this.paseo;
    if (!paseo) {
      return { ok: false, reason: "尚未连接到 Paseo" };
    }
    const settings = this.deps.settings.current();
    const requestId = this.reviewRequestId(record, turnId);
    const body =
      text?.trim() ||
      renderReviewPrompt(settings.reviewPrompt, {
        scope: settings.reviewScope,
        requestId,
        lastReviewHead: record.lastReviewHead,
      });
    const baseHead = await (this.deps.headOf ?? gitHeadOf)(record.cwd);
    const fresh = this.records.get(id);
    if (fresh !== record) {
      return { ok: false, reason: "会话状态已变化，未发送" };
    }
    if (
      trigger === "auto" &&
      (fresh.lifecycle !== "idle" ||
        fresh.pendingPermissionCount > 0 ||
        fresh.turns.at(-1)?.id !== turnId)
    ) {
      return { ok: false, reason: "会话状态已变化，未发送" };
    }
    const requestedAt = this.now();
    try {
      await withTimeout(
        paseo.agents.ref(id).send(body, { activeTurnBehavior: "steer" }),
        REVIEW_SEND_TIMEOUT_MS,
        "发送审查请求超时",
      );
    } catch (error) {
      const message = describeAnalysisError(error);
      fresh.review = {
        id: requestId,
        turnId,
        trigger,
        requestedAt,
        baseHead,
        reviewerIds: [],
        verifiedTurnId: null,
        verdict: null,
        error: `审查请求发送失败：${message}`,
        closedAt: null,
      };
      this.persist();
      return { ok: false, reason: message };
    }
    fresh.review = {
      id: requestId,
      turnId,
      trigger,
      requestedAt,
      baseHead,
      reviewerIds: [],
      verifiedTurnId: null,
      verdict: null,
      error: null,
      closedAt: null,
    };
    fresh.reviewedThroughTurnId = turnId;
    fresh.lastReviewHead = baseHead;
    fresh.updatedAt = this.now();
    this.persist();
    return { ok: true };
  }

  /**
   * Auto trigger: fires right after a successful analysis; the preconditions
   * are re-checked inside requestReview before the send.
   */
  private async maybeAutoReview(id: string, turnId: string): Promise<void> {
    const settings = this.deps.settings.current();
    if (settings.reviewTrigger !== "auto") {
      return;
    }
    const record = this.records.get(id);
    if (!record || record.turns.at(-1)?.id !== turnId) {
      return;
    }
    if (reviewEligibility(record, this.records.values(), settings) === null) {
      return;
    }
    const result = await this.requestReview(id, undefined, "auto", turnId);
    if (!result.ok) {
      console.warn(`[session-manager] review auto-request skipped: ${result.reason ?? "unknown"}`);
    }
  }

  /** Ignores the suggestion on the current turn; a later turn may suggest again. */
  dismissReview(id: string): MutationResult {
    const record = this.records.get(id);
    if (!record) {
      return { ok: false, reason: "会话不存在" };
    }
    const latest = record.turns.at(-1);
    if (!latest) {
      return { ok: false, reason: "暂无可忽略的建议" };
    }
    if (reviewInProgress(record, this.records.values())) {
      return { ok: false, reason: "已有进行中的审查" };
    }
    record.reviewDismissedTurnId = latest.id;
    this.persist();
    return { ok: true };
  }

  // ---- resume after a Paseo restart --------------------------------------

  /**
   * Resumes a dormant session by asking the daemon for its timeline tail;
   * fetching an unloaded agent resumes the provider session Paseo-side.
   */
  resume(id: string): Promise<MutationResult> {
    const record = this.records.get(id);
    if (!record) {
      return Promise.resolve({ ok: false, reason: "会话不存在" });
    }
    if (record.liveness !== "dormant") {
      return Promise.resolve({ ok: false, reason: "会话未处于待恢复状态" });
    }
    const inFlight = this.resumeTasks.get(id);
    if (inFlight) {
      return inFlight;
    }
    const paseo = this.paseo;
    if (!paseo) {
      return Promise.resolve({ ok: false, reason: "尚未连接到 Paseo" });
    }
    record.resumeState = "resuming";
    record.resumeError = null;
    this.persist();
    const task = this.resumeRun(paseo, id).finally(() => {
      this.resumeTasks.delete(id);
    });
    this.resumeTasks.set(id, task);
    return task;
  }

  /** Marks a dormant session as deliberately closed; never auto-resumed. */
  dismissResume(id: string): MutationResult {
    const record = this.records.get(id);
    if (!record) {
      return { ok: false, reason: "会话不存在" };
    }
    if (record.liveness !== "dormant") {
      return { ok: false, reason: "会话未处于待恢复状态" };
    }
    record.liveness = "closed";
    record.interruptedAt = null;
    record.resumeState = "idle";
    record.resumeError = null;
    record.deferredUntil = null;
    record.deferToQueue = false;
    record.updatedAt = this.now();
    this.persist();
    return { ok: true };
  }

  /**
   * Reopens a session the user closed or archived. A dormant record goes
   * through the regular resume instead. Closed agents resume with the same
   * timeline refetch dormant sessions use; archived ones need
   * `paseo agent reload`, the only path that unarchives before resuming.
   */
  reopen(id: string): Promise<MutationResult> {
    const record = this.records.get(id);
    if (!record) {
      return Promise.resolve({ ok: false, reason: "会话不存在" });
    }
    if (record.liveness === "dormant") {
      return this.resume(id);
    }
    if (record.liveness !== "closed" && record.liveness !== "archived") {
      return Promise.resolve({ ok: false, reason: "会话未关闭" });
    }
    const inFlight = this.resumeTasks.get(id);
    if (inFlight) {
      return inFlight;
    }
    const paseo = this.paseo;
    if (!paseo) {
      return Promise.resolve({ ok: false, reason: "尚未连接到 Paseo" });
    }
    record.resumeState = "resuming";
    record.resumeError = null;
    this.persist();
    const task = this.reopenRun(paseo, id).finally(() => {
      this.resumeTasks.delete(id);
    });
    this.resumeTasks.set(id, task);
    return task;
  }

  private async reopenRun(paseo: PaseoApi, id: string): Promise<MutationResult> {
    const record = this.records.get(id);
    if (!record) {
      return { ok: false, reason: "会话不存在" };
    }
    try {
      if (record.liveness === "archived") {
        const cli = this.deps.reloadAgentCli ?? reloadAgentViaCli;
        const result = await cli(id);
        if (!result.ok) {
          return this.reopenFailed(record, result.reason ?? "重新打开失败");
        }
        // The daemon already resumed the agent; pull its fresh snapshot.
        const fresh = await paseo.agents
          .ref(id)
          .refresh()
          .catch(() => null);
        if (fresh) {
          applyAgentSnapshot(record, fresh.agent, fresh.project);
        }
      } else {
        const payload = await withTimeout(
          paseo.agents.ref(id).timeline.refetch({
            direction: "tail",
            limit: 1,
            projection: "projected",
          }),
          RESUME_TIMEOUT_MS,
          REOPEN_TIMEOUT_TEXT,
        );
        const agent = payload.agent ?? null;
        if (agent) {
          applyAgentSnapshot(record, agent);
        }
      }
      // A forget during the await may have dropped the record.
      const current = this.records.get(id);
      if (!current) {
        return { ok: false, reason: "会话不存在" };
      }
      if (!isActiveLiveness(current.liveness)) {
        // Registry snapshots may lag the reload; ask once more before failing.
        await this.reconcile().catch((error: unknown) => {
          console.warn("[session-manager] reconcile after reopen failed", error);
        });
      }
      if (!isActiveLiveness(current.liveness)) {
        return this.reopenFailed(current, "重新打开失败：Paseo 未恢复该会话");
      }
      // Stale manual overrides and defers describe the pre-close session;
      // a reopened card rejoins the board under the automatic status.
      current.manualStatusOverride = null;
      current.interruptedAt = null;
      current.deferredUntil = null;
      current.deferToQueue = false;
      current.resumeState = "idle";
      current.resumeError = null;
      current.updatedAt = this.now();
      this.persist();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason =
        message.trim() === REOPEN_TIMEOUT_TEXT
          ? REOPEN_TIMEOUT_TEXT
          : `重新打开失败：${describeAnalysisError(error)}`;
      return this.reopenFailed(record, reason);
    }
  }

  private reopenFailed(record: SessionRecord, reason: string): MutationResult {
    record.resumeState = "failed";
    record.resumeError = reason;
    this.persist();
    return { ok: false, reason };
  }

  private async resumeRun(paseo: PaseoApi, id: string): Promise<MutationResult> {
    try {
      const payload = await withTimeout(
        paseo.agents.ref(id).timeline.refetch({
          direction: "tail",
          limit: 1,
          projection: "projected",
        }),
        RESUME_TIMEOUT_MS,
        RESUME_TIMEOUT_TEXT,
      );
      const record = this.records.get(id);
      if (!record) {
        return { ok: false, reason: "会话不存在" };
      }
      if (record.liveness === "closed") {
        // Dismissed while the refetch was in flight; keep it closed.
        return { ok: false, reason: "会话已标记为不再恢复" };
      }
      const agent = payload.agent ?? null;
      if (agent) {
        applyAgentSnapshot(record, agent);
      } else {
        // No snapshot in the payload: ask the registry what it now reports.
        void this.reconcile().catch((error: unknown) => {
          console.warn("[session-manager] reconcile after resume failed", error);
        });
      }
      record.resumeState = "idle";
      record.resumeError = null;
      this.persist();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason =
        message.trim() === RESUME_TIMEOUT_TEXT
          ? RESUME_TIMEOUT_TEXT
          : `恢复失败：${describeAnalysisError(error)}`;
      const record = this.records.get(id);
      if (record) {
        record.resumeState = "failed";
        record.resumeError = reason;
        this.persist();
      }
      return { ok: false, reason };
    }
  }

  /** Starts the once-per-process auto resume after the first reconcile. */
  private maybeStartAutoResume(): void {
    if (
      this.autoResumeStarted ||
      this.stopped ||
      !this.paseo ||
      !this.loadDone ||
      !this.reconciledOnce
    ) {
      return;
    }
    this.autoResumeStarted = true;
    // Team recovery runs after auto resume, so it never races it for the same agent.
    this.autoResumeDone = this.runAutoResume().then(() => this.notifyInterruptedTeams());
  }

  /** Resolves when the startup auto-resume pass finishes (tests). */
  waitForResume(): Promise<void> {
    return this.autoResumeDone ?? Promise.resolve();
  }

  private async runAutoResume(): Promise<void> {
    const policy = this.deps.settings.current().autoResume;
    if (policy === "off") {
      return;
    }
    const now = this.now();
    const dormant = [...this.records.values()].filter(
      (record) => record.liveness === "dormant" && !this.isExcludedRecord(record),
    );
    if (dormant.length === 0) {
      return;
    }
    const lookup = this.reviewLookup();
    const candidates = dormant
      .map((record) => ({ record, column: projectView(record, now, lookup).column }))
      .filter(({ record, column }) => {
        if (policy === "attention") {
          return column === "waiting_for_user" || column === "in_progress";
        }
        // "all": everything except sessions parked in the defer queue.
        return !(
          record.deferToQueue &&
          record.deferredUntil !== null &&
          record.deferredUntil > now
        );
      })
      .sort((left, right) => {
        const rank = (column: string): number => (column === "waiting_for_user" ? 0 : 1);
        return rank(left.column) - rank(right.column) || right.record.updatedAt - left.record.updatedAt;
      });
    for (const { record } of candidates) {
      record.resumeState = "queued";
    }
    if (candidates.length > 0) {
      this.persist();
    }
    const pending = candidates.map(({ record }) => record.id);
    let ok = 0;
    let failed = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (this.stopped) {
          return;
        }
        const id = pending.shift();
        if (id === undefined) {
          return;
        }
        const result = await this.resume(id);
        if (result.ok) {
          ok += 1;
        } else {
          failed += 1;
        }
      }
    };
    const workers: Promise<void>[] = [];
    for (let index = 0; index < Math.min(RESUME_CONCURRENCY, pending.length); index += 1) {
      workers.push(worker());
    }
    await Promise.all(workers);
    console.log(`[session-manager] resume: ${candidates.length} queued, ${ok} ok, ${failed} failed`);
  }

  /**
   * Tells each /dev-team coordinator which of its team sub-agents a restart
   * interrupted (see team-recovery.ts). Best-effort: a failure is logged and
   * left unmarked, so the next plugin start tries again.
   */
  private async notifyInterruptedTeams(): Promise<void> {
    if (this.deps.settings.current().teamRecovery === "off") {
      return;
    }
    for (const group of interruptedTeamGroups(this.records.values())) {
      const paseo = this.paseo;
      if (this.stopped || !paseo) {
        return;
      }
      await this.notifyCoordinator(paseo, group);
    }
  }

  private async notifyCoordinator(paseo: PaseoApi, group: TeamRecoveryGroup): Promise<void> {
    const id = group.coordinatorId;
    const coordinator = this.records.get(id);
    if (!coordinator || !isActiveLiveness(coordinator.liveness)) {
      // Closed or archived by the user (or unknown): leave the flow alone.
      return;
    }
    if (coordinator.liveness === "live" && coordinator.lifecycle === "working") {
      // Already running, likely told to continue; a send would interrupt it.
      return;
    }
    if (coordinator.liveness === "dormant") {
      const resumed = await this.resume(id);
      if (!resumed.ok) {
        console.warn(`[session-manager] team recovery: resume ${id} failed: ${resumed.reason ?? ""}`);
        return;
      }
    }
    try {
      await withTimeout(
        paseo.agents.ref(id).send(teamRecoveryMessage(group)),
        TEAM_NOTIFY_TIMEOUT_MS,
        "通知协调者超时",
      );
    } catch (error) {
      console.warn(`[session-manager] team recovery: notify ${id} failed`, error);
      return;
    }
    for (const member of group.members) {
      const record = this.records.get(member.id);
      if (record && record.interruptedAt === member.interruptedAt) {
        record.interruptNotifiedAt = member.interruptedAt;
      }
    }
    this.persist();
    console.log(
      `[session-manager] team recovery: notified ${id} about ${group.members.length} interrupted sub-agent(s)`,
    );
  }

  async testAnalyzer(): Promise<{ ok: boolean; durationMs: number; title?: string; error?: string }> {
    const startedAt = Date.now();
    const input: AnalyzerInput = {
      session: {
        id: "sample",
        provider: "claude",
        model: null,
        cwd: "/tmp/sample-project",
        branch: "main",
        agentTitle: null,
        pendingPermission: false,
        firstUserMessage: "帮我给登录页加上记住密码功能",
      },
      turns: [
        {
          id: "sample-turn",
          dedupeKey: "sample",
          userInput: "帮我给登录页加上记住密码功能",
          agentOutput: "已在登录页新增“记住密码”复选框，并补充了对应的单元测试，全部测试通过。",
          outcome: "completed",
          completedAt: startedAt,
          contextIncomplete: false,
        },
      ],
      previousAnalysis: null,
    };
    try {
      const config = this.runConfig();
      const analysis = await this.analyzerFor(config.agent).analyze(input, config);
      return { ok: true, durationMs: Date.now() - startedAt, title: analysis.title };
    } catch (error) {
      return { ok: false, durationMs: Date.now() - startedAt, error: describeAnalysisError(error) };
    }
  }

  detail(id: string): SessionDetail | null {
    const record = this.records.get(id);
    if (!record) {
      return null;
    }
    // Projected before the acknowledge so the opened card still reports the
    // ended defer once; the board marker clears on the next snapshot.
    const detail = projectDetail(
      record,
      this.now(),
      this.reviewLookup(),
      this.deps.digests?.listRuns(id) ?? [],
    );
    this.acknowledgeDeferEnd(record);
    return detail;
  }

  /** Opening a card acknowledges an expired defer; an active defer is untouched. */
  private acknowledgeDeferEnd(record: SessionRecord): void {
    if (record.deferredUntil === null || record.deferredUntil > this.now()) {
      return;
    }
    record.deferredUntil = null;
    record.deferToQueue = false;
    this.persist();
  }

  /** One logged analyzer call with its full result, for the 分析记录 dialog. */
  analysisRun(sessionId: string, runId: number): AnalysisRun | null {
    return this.deps.digests?.getRun(sessionId, runId) ?? null;
  }

  /**
   * Mermaid source + per-turn digest list for the flow section. Turns come
   * from history.db; turns not yet written there come from the live record.
   */
  flow(id: string): { ok: true; code: string; turns: FlowTurn[] } | { ok: false; error: string } {
    const record = this.records.get(id);
    if (!record) {
      return { ok: false, error: "会话不存在" };
    }
    const historyLabelByTurn = new Map<string, string>();
    for (const entry of record.history) {
      if (!historyLabelByTurn.has(entry.turnId)) {
        historyLabelByTurn.set(entry.turnId, entry.text);
      }
    }
    const merged: FlowTurnInput[] = [];
    const known = new Set<string>();
    for (const row of this.deps.digests?.listTurns(id) ?? []) {
      known.add(row.turnId);
      merged.push({
        turnId: row.turnId,
        completedAt: row.completedAt,
        userInput: row.userInput,
        step: row.step,
        historyLabel: historyLabelByTurn.get(row.turnId) ?? null,
        digest: row.digest,
        outcome: row.outcome,
        declared: row.declared,
        subAgents: row.subAgents,
      });
    }
    for (const turn of record.turns) {
      if (known.has(turn.id)) {
        continue;
      }
      merged.push({
        turnId: turn.id,
        completedAt: turn.completedAt,
        userInput: turn.userInput === null ? null : turn.userInput.slice(0, 300),
        step: null,
        historyLabel: historyLabelByTurn.get(turn.id) ?? null,
        digest: null,
        outcome: turn.outcome,
        declared: turn.declared ?? null,
        subAgents: [],
      });
    }
    const now = this.now();
    const lookup = this.reviewLookup();
    const children: FlowChild[] = [];
    for (const child of this.records.values()) {
      if (child.id === id || child.parentAgentId !== id) {
        continue;
      }
      const column = projectView(child, now, lookup).column;
      const declared = child.turns.at(-1)?.declared ?? null;
      children.push({
        id: child.id,
        createdAt: child.createdAt,
        columnLabel: COLUMNS.find((item) => item.id === column)?.label ?? column,
        detail: declared
          ? `${DECLARED_KIND_LABELS[declared.kind]}：${declared.text}`
          : (child.agentTitle ?? child.analysis?.title ?? null),
      });
    }
    const running =
      isActiveLiveness(record.liveness) &&
      (record.lifecycle === "working" || record.lifecycle === "waiting_permission")
        ? (record.analysis?.now ?? "运行中")
        : null;
    const result = buildFlow({ turns: merged, children, running });
    return { ok: true, code: result.code, turns: result.turns };
  }

  // ---- snapshot / reconcile / seed -------------------------------------

  async snapshot(): Promise<SnapshotResult> {
    await this.deps.settings.refresh().catch(() => undefined);
    if (this.paseo && this.now() - this.lastReconcileAt > RECONCILE_INTERVAL_MS) {
      const pending = this.reconcileOnce();
      const cap = delay(RECONCILE_WAIT_CAP_MS);
      await Promise.race([pending, cap.promise]);
      cap.cancel();
    }
    const settings = this.deps.settings.current();
    const config = normalizeAnalysisConfig(settings);
    const now = this.now();
    const lookup = this.reviewLookup();
    const cutoff = now - settings.closedRetentionDays * DAY_MS;
    const sessions = [...this.records.values()]
      .filter(
        (record) =>
          !this.isExcludedRecord(record) &&
          (isActiveLiveness(record.liveness) ||
            (record.archivedAt ?? record.updatedAt) >= cutoff),
      )
      .map(function project(record) {
        return projectView(record, now, lookup);
      })
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return {
      generatedAt: now,
      sessions,
      analyzer: {
        enabled: settings.enabled,
        agent: config.agent,
        model: config.model,
        problem: await this.analyzerProblem(config, settings.command),
      },
      seeding: this.seeding,
    };
  }

  private async analyzerProblem(config: AnalysisConfig, command: string): Promise<string | null> {
    const key = `${config.agent}\0${command}`;
    const cached = this.problemCache;
    if (cached && cached.key === key && this.now() - cached.at < PROBLEM_CACHE_MS) {
      return cached.value;
    }
    const value = await (this.deps.checkAnalyzer ?? defaultCheckAnalyzer)(config, command);
    this.problemCache = { key, at: this.now(), value };
    return value;
  }

  private reconcileOnce(): Promise<void> {
    if (!this.reconcileInFlight) {
      this.lastReconcileAt = this.now();
      this.reconcileInFlight = this.reconcile()
        .catch((error: unknown) => {
          console.warn("[session-manager] reconcile failed", error);
        })
        .finally(() => {
          this.reconcileInFlight = null;
          this.maybeStartAutoResume();
          if (!this.seedStarted && this.paseo) {
            this.seedStarted = true;
            void this.seed();
          }
        });
    }
    return this.reconcileInFlight;
  }

  /** Refreshes records from `agents.list`, filling in lost events. */
  async reconcile(paseo: PaseoApi | null = this.paseo): Promise<void> {
    if (!paseo) {
      return;
    }
    // Records created here before the load lands would hide the persisted ones
    // (restore skips known ids), losing dormant state and analyses on startup.
    await this.loading?.catch(() => undefined);
    const knownBefore = new Set(this.records.keys());
    const entries: AgentListEntry[] = [];
    let cursor: string | undefined;
    let complete = false;
    for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
      const result = await paseo.agents.list({
        filter: { includeArchived: true },
        sort: [{ key: "updated_at", direction: "desc" }],
        page: { limit: RECONCILE_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
      });
      entries.push(...result.entries);
      const next = result.pageInfo.nextCursor;
      if (!result.pageInfo.hasMore || !next) {
        complete = true;
        break;
      }
      cursor = next;
    }
    const retention = this.deps.settings.current().closedRetentionDays * DAY_MS;
    const exclusions = this.exclusions();
    const seen = new Set<string>();
    let changed = false;
    for (const entry of entries) {
      const agent = entry.agent;
      seen.add(agent.id);
      const existing = this.records.get(agent.id);
      if (agent.labels && isExcludedAgent(agent.labels, exclusions)) {
        if (existing) {
          this.removeRecord(agent.id);
          changed = true;
        }
        continue;
      }
      if (existing) {
        // First reconcile after a plugin/daemon restart: a persisted live
        // record whose agent now reports closed went down with the daemon.
        const crashRecovery = !this.reconciledOnce && existing.liveness === "live";
        const interrupted =
          crashRecovery &&
          (existing.lifecycle === "working" || existing.pendingPermissionCount > 0);
        changed =
          applyAgentSnapshot(existing, agent, entry.project, {
            dormantOnClosed: crashRecovery,
          }) || changed;
        if (interrupted && existing.liveness === "dormant" && existing.interruptedAt === null) {
          existing.interruptedAt = this.now();
          changed = true;
        }
        this.pruneReviewerLabels(existing);
        continue;
      }
      const archivedAt = agent.archivedAt ? Date.parse(agent.archivedAt) : null;
      if (archivedAt !== null && Number.isFinite(archivedAt) && this.now() - archivedAt > retention) {
        continue;
      }
      const created = newRecord(agent, this.now(), entry.project);
      this.records.set(agent.id, created);
      this.pruneReviewerLabels(created);
      changed = true;
    }
    if (complete) {
      for (const id of knownBefore) {
        if (!seen.has(id) && this.records.has(id)) {
          this.records.delete(id);
          this.deps.digests?.removeSession(id);
          changed = true;
        }
      }
    }
    changed = this.backfillReviewers() || changed;
    // A failed pass retries as "first" so crash recovery still applies.
    this.reconciledOnce = true;
    if (changed) {
      this.persist();
    }
  }

  /**
   * Reload-gap cover: a reviewer created while the plugin was down joins its
   * parent's open review (matched by parentAgentId + createdAt); one labeled
   * for another review stays out.
   */
  private backfillReviewers(): boolean {
    let changed = false;
    for (const record of this.records.values()) {
      const review = record.review;
      if (!review || review.closedAt !== null || review.error !== null) {
        continue;
      }
      for (const child of this.records.values()) {
        if (
          child.id === record.id ||
          child.parentAgentId !== record.id ||
          child.createdAt < review.requestedAt ||
          review.reviewerIds.includes(child.id) ||
          review.reviewerIds.length >= MAX_REVIEWERS
        ) {
          continue;
        }
        const tagged = child.labels[REVIEW_LABEL];
        if (tagged !== undefined && tagged !== review.id) {
          continue;
        }
        review.reviewerIds.push(child.id);
        changed = true;
      }
    }
    return changed;
  }

  /** Backfills recent turns for sessions that have none; runs once, in the background. */
  async seed(): Promise<void> {
    const paseo = this.paseo;
    if (!paseo) {
      return;
    }
    this.seeding = true;
    try {
      const candidates = [...this.records.values()]
        .filter(
          (record) =>
            record.liveness === "live" && record.turns.length === 0 && record.lifecycle !== "working",
        )
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, SEED_MAX_AGENTS);
      let analyzeBudget = this.deps.settings.current().seedAnalyzeLimit;
      for (const candidate of candidates) {
        if (this.stopped) {
          return;
        }
        try {
          const result = await paseo.agents.ref(candidate.id).timeline.refetch({
            direction: "tail",
            limit: SEED_TIMELINE_LIMIT,
            projection: "projected",
          });
          const record = this.records.get(candidate.id);
          if (!record || record.turns.length > 0) {
            continue;
          }
          const built = turnsFromTimelineEntries(result.entries, result.hasOlder);
          if (!record.firstUserMessageKnown && result.hasOlder === false) {
            const first = firstUserMessageFrom(result.entries.map((entry) => entry.item));
            if (first) {
              record.firstUserMessage = first;
              record.firstUserMessageKnown = true;
            }
          }
          if (built.length === 0) {
            continue;
          }
          record.turns = built.map((entry) => entry.turn);
          record.completedAt = built.at(-1)?.turn.completedAt ?? null;
          for (const entry of built) {
            this.deps.digests?.upsertTurn(record.id, entry.turn, entry.subAgents, this.now());
          }
          if (analyzeBudget > 0) {
            analyzeBudget -= 1;
            record.analysisState = "queued";
            this.enqueue(record.id);
          } else {
            record.analysisState = "awaiting_output";
          }
          this.persist();
        } catch (error) {
          console.warn(`[session-manager] seed failed for ${candidate.id}`, error);
        }
      }
    } finally {
      this.seeding = false;
    }
  }

  private persist(): void {
    this.deps.store.schedule(() => [...this.records.values()]);
  }
}
