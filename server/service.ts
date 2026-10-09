import {
  normalizeAnalysisConfig,
  type AnalysisConfig,
} from "../shared/analysis-config";
import type { AnalyzerSettings } from "../shared/settings";
import type { Analysis, AnalysisStatus, SessionDetail, SessionView } from "../shared/types";
import { CliAnalyzer, DEFAULT_ANALYZER_TIMEOUT_MS, type Analyzer } from "./analyzer/analyzer";
import type { AnalyzerInput } from "./analyzer/prompt";
import { resolveAnalyzerBinary } from "./cli";
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
import { applyAgentSnapshot, applyHookAgent, newRecord } from "./lifecycle";
import { projectDetail, projectView } from "./projection";
import {
  MAX_TURNS_PER_SESSION,
  copyRecord,
  type SessionRecord,
  type StateStore,
} from "./store";
import { decideTitleWrite, writeTitleViaCli } from "./title-writeback";
import { firstUserMessageFrom, turnFromTurnEnded, turnsFromTimelineEntries } from "./turns";
import { normalizeTitle } from "../shared/types";

const RECONCILE_INTERVAL_MS = 5_000;
const RECONCILE_WAIT_CAP_MS = 4_000;
const RECONCILE_PAGE_LIMIT = 200;
const RECONCILE_MAX_PAGES = 3;
const SEED_MAX_AGENTS = 50;
const SEED_TIMELINE_LIMIT = 300;
const PROBLEM_CACHE_MS = 30_000;
const DAY_MS = 86_400_000;

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

export class SessionManagerService {
  private readonly records = new Map<string, SessionRecord>();
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private readonly running = new Set<string>();
  private readonly analyzer: Analyzer;
  private readonly now: () => number;
  private paseo: PaseoApi | null = null;
  private reconcileInFlight: Promise<void> | null = null;
  private lastReconcileAt = 0;
  private seedStarted = false;
  private seeding = false;
  private stopped = false;
  private problemCache: { key: string; at: number; value: string | null } | null = null;
  private readonly idleWaiters: Array<() => void> = [];

  constructor(private readonly deps: ServiceDeps) {
    this.analyzer = deps.analyzer ?? new CliAnalyzer();
    this.now = deps.now ?? Date.now;
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

  async load(): Promise<number> {
    const restored = await this.deps.store.load();
    const count = this.restore(restored);
    if (count > 0) {
      this.persist();
    }
    return count;
  }

  stop(): void {
    this.stopped = true;
  }

  touchPaseo(paseo: PaseoApi): void {
    this.paseo = paseo;
  }

  /** Called when settings change: queued work may now be runnable. */
  settingsChanged(): void {
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
    }
    return record;
  }

  onCreated(event: CreatedEvent): void {
    const record = this.ensure(event.agent);
    record.liveness = "live";
    record.updatedAt = this.now();
    this.persist();
  }

  onTurnStarted(event: TurnStartedEvent): void {
    const record = this.ensure(event.agent);
    record.liveness = "live";
    record.lifecycle = "working";
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
  }

  onTurnEnded(event: TurnEndedEvent): void {
    const record = this.ensure(event.agent);
    const now = this.now();
    record.updatedAt = now;
    record.liveness = record.liveness === "archived" ? "archived" : "live";
    record.lifecycle = event.outcome.kind === "failed" ? "error" : "idle";
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
    const turn = turnFromTurnEnded(event.timeline, event.outcome, event.turnId, now);
    if (!turn) {
      this.persist();
      return;
    }
    const lastTurn = record.turns.at(-1);
    const byId = record.turns.findIndex((candidate) => candidate.id === turn.id);
    let enqueue = false;
    if (byId >= 0) {
      const existing = record.turns[byId];
      if (existing.dedupeKey !== turn.dedupeKey) {
        record.turns[byId] = { ...turn, completedAt: now };
        enqueue = byId === record.turns.length - 1;
      }
    } else if (lastTurn && lastTurn.dedupeKey === turn.dedupeKey) {
      // Same content under a different id: a repeated event, nothing to do.
    } else {
      record.turns.push(turn);
      record.turns = record.turns.slice(-MAX_TURNS_PER_SESSION);
      enqueue = true;
    }
    if (enqueue) {
      record.completedAt = turn.completedAt;
      record.analysisError = null;
      record.analysisState = "queued";
      this.enqueue(record.id);
    }
    this.persist();
  }

  onClosed(event: ClosedEvent): void {
    const record = this.ensure(event.agent);
    if (record.liveness !== "archived") {
      record.liveness = "closed";
    }
    record.pendingPermissionCount = 0;
    record.updatedAt = this.now();
    this.persist();
  }

  onArchived(event: ArchivedEvent): void {
    const record = this.ensure(event.agent);
    record.liveness = "archived";
    const at = Date.parse(event.archivedAt);
    record.archivedAt = Number.isFinite(at) ? at : this.now();
    record.pendingPermissionCount = 0;
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

  private buildInput(record: SessionRecord): AnalyzerInput {
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
      previousAnalysis: record.analysis ? copyRecord(record).analysis : null,
    };
  }

  private runConfig(): AnalysisConfig & { command: string; timeoutMs: number } {
    const settings = this.deps.settings.current();
    const config = normalizeAnalysisConfig(settings);
    return {
      ...config,
      command: settings.command,
      timeoutMs: (settings.timeoutSeconds || DEFAULT_ANALYZER_TIMEOUT_MS / 1000) * 1000,
    };
  }

  private async runAnalysis(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) {
      return;
    }
    const targetTurnId = record.turns.at(-1)?.id;
    if (!targetTurnId) {
      return;
    }
    record.analysisState = "running";
    record.analysisError = null;
    let result: Analysis | null = null;
    let failure: string | null = null;
    try {
      result = await this.analyzer.analyze(this.buildInput(record), this.runConfig());
    } catch (error) {
      failure = describeAnalysisError(error);
    }
    const current = this.records.get(id);
    if (!current || current.turns.at(-1)?.id !== targetTurnId) {
      return;
    }
    if (current.liveness === "archived") {
      this.settleDropped(current);
      current.analysisState = current.analysis ? "ready" : "awaiting_output";
      this.persist();
      return;
    }
    if (result) {
      current.analysis = result;
      current.analysisState = "ready";
      current.analysisError = null;
      current.analyzedTurnId = targetTurnId;
      this.persist();
      void this.maybeWriteBackTitle(id, result.title);
    } else {
      current.analysisState = "failed";
      current.analysisError = failure;
      this.persist();
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
    if (record.liveness !== "live") {
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
    this.persist();
    return { ok: true };
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
      const analysis = await this.analyzer.analyze(input, this.runConfig());
      return { ok: true, durationMs: Date.now() - startedAt, title: analysis.title };
    } catch (error) {
      return { ok: false, durationMs: Date.now() - startedAt, error: describeAnalysisError(error) };
    }
  }

  detail(id: string): SessionDetail | null {
    const record = this.records.get(id);
    return record ? projectDetail(record) : null;
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
    const cutoff = this.now() - settings.closedRetentionDays * DAY_MS;
    const sessions = [...this.records.values()]
      .filter(
        (record) =>
          record.liveness === "live" || (record.archivedAt ?? record.updatedAt) >= cutoff,
      )
      .map(projectView)
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return {
      generatedAt: this.now(),
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
    const seen = new Set<string>();
    let changed = false;
    for (const entry of entries) {
      const agent = entry.agent;
      seen.add(agent.id);
      const existing = this.records.get(agent.id);
      if (existing) {
        changed = applyAgentSnapshot(existing, agent, entry.project) || changed;
        continue;
      }
      const archivedAt = agent.archivedAt ? Date.parse(agent.archivedAt) : null;
      if (archivedAt !== null && Number.isFinite(archivedAt) && this.now() - archivedAt > retention) {
        continue;
      }
      this.records.set(agent.id, newRecord(agent, this.now(), entry.project));
      changed = true;
    }
    if (complete) {
      for (const id of knownBefore) {
        if (!seen.has(id) && this.records.has(id)) {
          this.records.delete(id);
          changed = true;
        }
      }
    }
    if (changed) {
      this.persist();
    }
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
          const turns = turnsFromTimelineEntries(result.entries);
          if (!record.firstUserMessageKnown && result.hasOlder === false) {
            const first = firstUserMessageFrom(result.entries.map((entry) => entry.item));
            if (first) {
              record.firstUserMessage = first;
              record.firstUserMessageKnown = true;
            }
          }
          if (turns.length === 0) {
            continue;
          }
          record.turns = turns;
          record.completedAt = turns.at(-1)?.completedAt ?? null;
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
