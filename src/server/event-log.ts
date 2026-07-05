/**
 * Per-debate in-memory event buffer + subscriber set (server-private).
 *
 * Responsibilities (design §3 决策 3 / §6):
 *  - assign a monotonic integer id to every event (SSE `id:` field)
 *  - broadcast to live subscribers
 *  - replay `id > lastEventId` buffered events on (re)connect
 *  - keep memory bounded: lifecycle events are retained (replay correctness),
 *    `agent_progress` events are droppable once the buffer exceeds a byte
 *    threshold — their full text is authoritatively carried by `agent_complete`
 *  - after the debate reaches a terminal state, retain the buffer for a TTL so
 *    late reconnects can still replay, then evict.
 */

import type { DebateEvent } from './protocol.js';

export interface EventLogSubscriber {
  (event: DebateEvent, id: number): void;
}

export interface EventLogOptions {
  /** Byte budget above which the oldest droppable (progress) events are evicted. */
  maxBytes?: number;
  /** Milliseconds to retain the buffer after `markTerminal()` before eviction. */
  ttlMs?: number;
  /** Invoked when the terminal TTL elapses (lets the owner drop its reference). */
  onEvict?: () => void;
}

interface BufferedEvent {
  id: number;
  event: DebateEvent;
  bytes: number;
  /** Only `agent_progress` chunks may be dropped under memory pressure. */
  droppable: boolean;
}

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024; // 4 MB
const DEFAULT_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class EventLog {
  private buffer: BufferedEvent[] = [];
  private subscribers = new Set<EventLogSubscriber>();
  private lastId = 0;
  private bufferedBytes = 0;
  private terminalReached = false;
  private evicted = false;
  private evictTimer?: ReturnType<typeof setTimeout>;

  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly onEvict?: () => void;

  constructor(options: EventLogOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.onEvict = options.onEvict;
  }

  get terminal(): boolean {
    return this.terminalReached;
  }

  /** Assign an id, buffer the event, broadcast it, then evict progress if over budget. */
  push(event: DebateEvent): number {
    const id = ++this.lastId;
    const bytes = estimateBytes(event);
    this.buffer.push({
      id,
      event,
      bytes,
      droppable: event.type === 'agent_progress',
    });
    this.bufferedBytes += bytes;
    this.evictProgressIfNeeded();

    for (const fn of this.subscribers) {
      fn(event, id);
    }
    return id;
  }

  /** Replay buffered events with id strictly greater than `lastEventId`. */
  replayFrom(lastEventId: number | null, fn: EventLogSubscriber): void {
    const threshold = lastEventId ?? 0;
    for (const entry of this.buffer) {
      if (entry.id > threshold) {
        fn(entry.event, entry.id);
      }
    }
  }

  /** Register a live subscriber; returns an unsubscribe function. */
  subscribe(fn: EventLogSubscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Mark the debate terminal and start the TTL eviction timer (idempotent). */
  markTerminal(): void {
    if (this.terminalReached) return;
    this.terminalReached = true;
    this.evictTimer = setTimeout(() => this.evict(), this.ttlMs);
    // Do not keep the process alive purely for eviction.
    this.evictTimer.unref?.();
  }

  /** Whether the buffer has been evicted after its terminal TTL. */
  get isEvicted(): boolean {
    return this.evicted;
  }

  private evict(): void {
    this.evicted = true;
    this.buffer = [];
    this.bufferedBytes = 0;
    this.subscribers.clear();
    this.onEvict?.();
  }

  private evictProgressIfNeeded(): void {
    if (this.bufferedBytes <= this.maxBytes) return;
    // Drop the oldest droppable (progress) events until under budget or none left.
    const kept: BufferedEvent[] = [];
    for (const entry of this.buffer) {
      if (this.bufferedBytes > this.maxBytes && entry.droppable) {
        this.bufferedBytes -= entry.bytes;
        continue;
      }
      kept.push(entry);
    }
    this.buffer = kept;
  }
}

function estimateBytes(event: DebateEvent): number {
  // Cheap, deterministic size proxy for the serialized frame.
  return Buffer.byteLength(JSON.stringify(event.data), 'utf-8');
}
