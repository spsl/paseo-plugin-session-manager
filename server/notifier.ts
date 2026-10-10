/**
 * Turns session events into transcript cards and spoken announcements. Every
 * method is best-effort and never rejects: hooks must stay fast and a card or
 * a sentence is a nicety. No LLM call happens here; the sentence comes from the
 * per-turn analysis the service already runs.
 */
import {
  failedTurnCard,
  pendingTurnCard,
  permissionCard,
  permissionSpeech,
  readyTurnCard,
  resolvedPermissionCard,
  supersededTurnCard,
  type PermissionRequestInfo,
  type SessionCard,
} from "../shared/card";
import {
  shouldAnnounce,
  type AnnouncementKind,
  type SpeechSettings,
} from "../shared/speech";
import { speechOf, type Analysis, type TurnOutcome } from "../shared/types";
import type { AnnouncementFeed } from "./announcements";
import { permissionRowId, turnRowId, type CardPublisher } from "./cards";
import type { PaseoApi } from "./host-types";

export type NotifyAgent = {
  id: string;
  parentAgentId: string | null;
  /** The session's display name (title, analysis title or folder). */
  name: string;
};

export type Notifier = {
  turnPending(paseo: PaseoApi, agent: NotifyAgent, turnId: string): Promise<void>;
  turnReady(
    paseo: PaseoApi,
    agent: NotifyAgent,
    turnId: string,
    analysis: Analysis,
    outcome: TurnOutcome,
  ): Promise<void>;
  turnFailed(paseo: PaseoApi, agent: NotifyAgent, turnId: string, error: string): Promise<void>;
  turnSuperseded(paseo: PaseoApi, agent: NotifyAgent, turnId: string): Promise<void>;
  permissionRequested(
    paseo: PaseoApi,
    agent: NotifyAgent,
    request: PermissionRequestInfo,
  ): Promise<void>;
  permissionResolved(
    paseo: PaseoApi,
    agent: NotifyAgent,
    requestId: string,
    behavior: string,
  ): Promise<void>;
};

/** Which announcement a finished analysis becomes: a failed turn, a hand-off to the user, or plain completion. */
export function announcementKindFor(analysis: Analysis, outcome: TurnOutcome): AnnouncementKind {
  if (outcome === "failed") {
    return "error";
  }
  if (
    analysis.needsUserAttention ||
    analysis.status === "waiting_for_user" ||
    analysis.status === "blocked"
  ) {
    return "waiting";
  }
  return "finished";
}

/** A permission-kind request that is really a question is gated by the 问题 switch. */
export function permissionAnnouncementKind(request: PermissionRequestInfo): AnnouncementKind {
  return request.kind === "question" ? "waiting" : "permission";
}

const MAX_TRACKED_REQUESTS = 300;

export type NotifierDeps = {
  publisher: CardPublisher;
  feed: AnnouncementFeed;
  speechSettings: () => SpeechSettings;
};

export class CardNotifier implements Notifier {
  /** Request cards by request id, so resolving can rewrite the same card. */
  private readonly requests = new Map<string, { agentId: string; card: SessionCard }>();

  constructor(private readonly deps: NotifierDeps) {}

  private async card(
    paseo: PaseoApi,
    agentId: string,
    rowId: string,
    card: SessionCard,
  ): Promise<void> {
    try {
      await this.deps.publisher.publish(paseo, agentId, rowId, card);
    } catch (error) {
      console.warn("[session-manager] card publish failed", error);
    }
  }

  private announce(agent: NotifyAgent, kind: AnnouncementKind, text: string): void {
    if (text.trim() === "") {
      return;
    }
    if (!shouldAnnounce(kind, agent.parentAgentId, this.deps.speechSettings())) {
      return;
    }
    this.deps.feed.push(agent.id, kind, text);
  }

  turnPending(paseo: PaseoApi, agent: NotifyAgent, turnId: string): Promise<void> {
    return this.card(paseo, agent.id, turnRowId(turnId), pendingTurnCard());
  }

  async turnReady(
    paseo: PaseoApi,
    agent: NotifyAgent,
    turnId: string,
    analysis: Analysis,
    outcome: TurnOutcome,
  ): Promise<void> {
    this.announce(agent, announcementKindFor(analysis, outcome), speechOf(analysis));
    await this.card(paseo, agent.id, turnRowId(turnId), readyTurnCard(analysis));
  }

  turnFailed(paseo: PaseoApi, agent: NotifyAgent, turnId: string, error: string): Promise<void> {
    return this.card(paseo, agent.id, turnRowId(turnId), failedTurnCard(error));
  }

  turnSuperseded(paseo: PaseoApi, agent: NotifyAgent, turnId: string): Promise<void> {
    return this.card(paseo, agent.id, turnRowId(turnId), supersededTurnCard());
  }

  async permissionRequested(
    paseo: PaseoApi,
    agent: NotifyAgent,
    request: PermissionRequestInfo,
  ): Promise<void> {
    const card = permissionCard(request);
    this.requests.set(request.id, { agentId: agent.id, card });
    if (this.requests.size > MAX_TRACKED_REQUESTS) {
      const oldest = this.requests.keys().next();
      if (!oldest.done) {
        this.requests.delete(oldest.value);
      }
    }
    this.announce(agent, permissionAnnouncementKind(request), permissionSpeech(agent.name, request));
    await this.card(paseo, agent.id, permissionRowId(request.id), card);
  }

  async permissionResolved(
    paseo: PaseoApi,
    agent: NotifyAgent,
    requestId: string,
    behavior: string,
  ): Promise<void> {
    const known = this.requests.get(requestId);
    if (!known) {
      return;
    }
    this.requests.delete(requestId);
    await this.card(
      paseo,
      known.agentId,
      permissionRowId(requestId),
      resolvedPermissionCard(known.card, behavior),
    );
  }
}
