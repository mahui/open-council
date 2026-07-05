import { describe, it, expect, vi } from 'vitest';
import { EventLog } from '../../src/server/event-log.js';
import type { DebateEvent } from '../../src/server/protocol.js';

function phaseEvent(index: number): DebateEvent {
  return { type: 'phase', data: { phase: 'broadcast', index, total: 3 } };
}

function progressEvent(chunk: string): DebateEvent {
  return { type: 'agent_progress', data: { agentId: 'a1', role: 'Analyst', chunk } };
}

function collect(log: EventLog, from: number | null): Array<{ id: number; event: DebateEvent }> {
  const out: Array<{ id: number; event: DebateEvent }> = [];
  log.replayFrom(from, (event, id) => out.push({ id, event }));
  return out;
}

describe('EventLog', () => {
  it('assigns monotonically increasing ids', () => {
    const log = new EventLog();
    expect(log.push(phaseEvent(0))).toBe(1);
    expect(log.push(phaseEvent(1))).toBe(2);
    expect(log.push(phaseEvent(2))).toBe(3);
  });

  it('replays only events with id greater than lastEventId', () => {
    const log = new EventLog();
    log.push(phaseEvent(0)); // id 1
    log.push(phaseEvent(1)); // id 2
    log.push(phaseEvent(2)); // id 3

    expect(collect(log, null).map((e) => e.id)).toEqual([1, 2, 3]);
    expect(collect(log, 1).map((e) => e.id)).toEqual([2, 3]);
    expect(collect(log, 3).map((e) => e.id)).toEqual([]);
  });

  it('broadcasts live events to subscribers and stops after unsubscribe', () => {
    const log = new EventLog();
    const received: number[] = [];
    const unsubscribe = log.subscribe((_event, id) => received.push(id));

    log.push(phaseEvent(0));
    log.push(phaseEvent(1));
    unsubscribe();
    log.push(phaseEvent(2));

    expect(received).toEqual([1, 2]);
  });

  it('evicts oldest progress events under memory pressure but retains lifecycle events', () => {
    // Budget fits the phase event + exactly one 200-byte progress event, so
    // pushing a second progress forces eviction of the oldest progress only.
    const log = new EventLog({ maxBytes: 400 });
    const big = 'x'.repeat(200);

    log.push(phaseEvent(0)); // id 1 — lifecycle, retained
    log.push(progressEvent(big)); // id 2 — droppable
    log.push(progressEvent(big)); // id 3 — droppable, triggers eviction of id 2

    const ids = collect(log, null).map((e) => e.id);
    expect(ids).toContain(1); // lifecycle survives
    expect(ids).not.toContain(2); // oldest progress dropped
    expect(ids).toContain(3); // newest progress kept
  });

  it('never drops lifecycle events even when far over budget', () => {
    const log = new EventLog({ maxBytes: 10 });
    const big = 'x'.repeat(500);
    log.push(phaseEvent(0)); // id 1
    log.push({ type: 'result', data: { session: { big } as never } }); // id 2 lifecycle
    log.push(progressEvent(big)); // id 3 droppable → dropped

    const types = collect(log, null).map((e) => e.event.type);
    expect(types).toContain('phase');
    expect(types).toContain('result');
    expect(types).not.toContain('agent_progress');
  });

  it('starts terminal and reports state via getters', () => {
    const log = new EventLog();
    expect(log.terminal).toBe(false);
    log.markTerminal();
    expect(log.terminal).toBe(true);
  });

  it('evicts the buffer and invokes onEvict after the terminal TTL', () => {
    vi.useFakeTimers();
    try {
      const onEvict = vi.fn();
      const log = new EventLog({ ttlMs: 1000, onEvict });
      log.push(phaseEvent(0));
      log.markTerminal();

      expect(log.isEvicted).toBe(false);
      vi.advanceTimersByTime(1000);

      expect(log.isEvicted).toBe(true);
      expect(onEvict).toHaveBeenCalledOnce();
      expect(collect(log, null)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('markTerminal is idempotent', () => {
    vi.useFakeTimers();
    try {
      const onEvict = vi.fn();
      const log = new EventLog({ ttlMs: 1000, onEvict });
      log.markTerminal();
      log.markTerminal();
      vi.advanceTimersByTime(1000);
      expect(onEvict).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
