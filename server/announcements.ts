import type { Announcement, AnnouncementKind } from "../shared/speech";

export const FEED_CAPACITY = 100;

/** Bounded in-memory ring of announcement events with a monotonically increasing id. */
export class AnnouncementFeed {
  private events: Announcement[] = [];
  private nextId: number;

  /** Ids start at the clock so they never repeat across a daemon restart (clients dedupe by id). */
  constructor(
    private readonly capacity = FEED_CAPACITY,
    private readonly now: () => number = Date.now,
    firstId?: number,
  ) {
    this.nextId = firstId ?? this.now();
  }

  push(agentId: string, kind: AnnouncementKind, text: string): Announcement {
    const event: Announcement = {
      id: this.nextId,
      agentId,
      kind,
      text,
      createdAt: this.now(),
    };
    this.nextId += 1;
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    return event;
  }

  /** Events with id greater than `since`, oldest first, plus the cursor to pass next. */
  since(since: number): { events: Announcement[]; cursor: number } {
    const events = this.events.filter(function newer(event) {
      return event.id > since;
    });
    return { events, cursor: this.nextId - 1 };
  }
}
