/**
 * Appends cards to an agent's own transcript. The same row id replaces the
 * earlier row (live and on refetch), so a pending card is later overwritten by
 * the final one. Rows live in the daemon's memory. Ported from herald (MIT).
 */
import {
  SESSION_CARD_KIND,
  SESSION_CARD_VERSION,
  type SessionCard,
} from "../shared/card";
import type { PaseoApi } from "./host-types";

export type CardPublisher = {
  publish(paseo: PaseoApi, agentId: string, rowId: string, card: SessionCard): Promise<void>;
};

export class TimelineCardPublisher implements CardPublisher {
  /**
   * One chain per row. The pending append and the final one carry the same row
   * id and are started fire-and-forget, so without this a slow pending write
   * could land after the final card and leave it reading 「正在分析…」 forever.
   */
  private readonly chains = new Map<string, Promise<void>>();
  /** Reported once per distinct cause; an old host would otherwise log on every event. */
  private readonly reported = new Set<string>();

  async publish(paseo: PaseoApi, agentId: string, rowId: string, card: SessionCard): Promise<void> {
    const key = `${agentId}\0${rowId}`;
    const next = (this.chains.get(key) ?? Promise.resolve()).then(() =>
      this.append(paseo, agentId, rowId, card),
    );
    this.chains.set(key, next);
    try {
      await next;
    } finally {
      // Only the last link clears the row, or a later append would lose its queue.
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    }
  }

  /** Never rejects: a card is a nicety and the chain behind it must keep moving. */
  private async append(
    paseo: PaseoApi,
    agentId: string,
    rowId: string,
    card: SessionCard,
  ): Promise<void> {
    try {
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id: rowId,
        kind: SESSION_CARD_KIND,
        version: SESSION_CARD_VERSION,
        data: card,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.reported.has(message)) {
        return;
      }
      this.reported.add(message);
      console.warn(`[session-manager] 无法向 Agent ${agentId} 的对话追加卡片：${message}`);
    }
  }
}

export function turnRowId(turnId: string): string {
  return `session-manager:turn:${turnId}`;
}

export function permissionRowId(requestId: string): string {
  return `session-manager:perm:${requestId}`;
}
