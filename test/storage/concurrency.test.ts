import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { isProcessAlive, ConcurrencyManager } from '../../src/storage/concurrency.js';
import { initDatabase, closeDatabase } from '../../src/storage/database.js';

interface SlotRow {
  slot_id: number;
  model_id: string;
  pid: number;
  resource_cost: number;
}

/** A pid guaranteed not to correspond to a live process (used to simulate a crashed instance). */
const DEAD_PID = 2147483647;

function makeDb(): Database.Database {
  // ':memory:' per TEST-04 — isolated, no cleanup needed beyond closeDatabase.
  return initDatabase(':memory:');
}

function insertSlot(db: Database.Database, modelId: string, pid: number, cost: number): void {
  db.prepare(
    'INSERT INTO resource_slots (model_id, pid, acquired_at, resource_cost) VALUES (?, ?, ?, ?)',
  ).run(modelId, pid, new Date().toISOString(), cost);
}

function allSlots(db: Database.Database): SlotRow[] {
  return db.prepare('SELECT slot_id, model_id, pid, resource_cost FROM resource_slots').all() as SlotRow[];
}

describe('isProcessAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when process.kill succeeds (process reachable)', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(isProcessAlive(1234)).toBe(true);
    expect(spy).toHaveBeenCalledWith(1234, 0);
  });

  it('returns true on EPERM (process exists but not signalable)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    expect(isProcessAlive(1)).toBe(true);
  });

  it('returns false on ESRCH (no such process)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect(isProcessAlive(2147483647)).toBe(false);
  });

  it('reports the current process as alive (real call, no mock)', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});

describe('ConcurrencyManager.acquire', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('acquires a slot when under both the per-model and global limits', () => {
    const mgr = new ConcurrencyManager(db, 10);

    expect(mgr.acquire('model-a', 2, 1)).toBe(true);

    const rows = allSlots(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.model_id).toBe('model-a');
    expect(rows[0]!.pid).toBe(process.pid);
  });

  it('same model, max_concurrent=2: third acquire is refused (caller must queue/retry)', () => {
    const mgr = new ConcurrencyManager(db, 100);

    expect(mgr.acquire('model-a', 2, 1)).toBe(true);
    expect(mgr.acquire('model-a', 2, 1)).toBe(true);
    // Per-model slot count is now 2, at the max_concurrent ceiling.
    expect(mgr.acquire('model-a', 2, 1)).toBe(false);

    expect(allSlots(db)).toHaveLength(2);
  });

  it('a different model is unaffected by another model’s per-model limit', () => {
    const mgr = new ConcurrencyManager(db, 100);

    expect(mgr.acquire('model-a', 1, 1)).toBe(true);
    expect(mgr.acquire('model-a', 1, 1)).toBe(false); // model-a is now full
    expect(mgr.acquire('model-b', 1, 1)).toBe(true); // model-b has its own ceiling
  });

  it('acquire is refused once the global_resource_limit would be exceeded', () => {
    const mgr = new ConcurrencyManager(db, 3);

    expect(mgr.acquire('model-a', 10, 2)).toBe(true); // total cost 2, within limit of 3
    expect(mgr.acquire('model-b', 10, 2)).toBe(false); // 2 + 2 = 4 > 3 → refused

    expect(allSlots(db)).toHaveLength(1);
  });

  it('acquire succeeds exactly at the global limit boundary (cost sum == limit)', () => {
    const mgr = new ConcurrencyManager(db, 3);

    expect(mgr.acquire('model-a', 10, 2)).toBe(true);
    expect(mgr.acquire('model-b', 10, 1)).toBe(true); // 2 + 1 = 3, not > 3 → allowed

    expect(allSlots(db)).toHaveLength(2);
  });

  it('zombie slot (pid no longer alive) is cleaned up before limit checks, freeing capacity', () => {
    insertSlot(db, 'model-a', DEAD_PID, 1);
    const mgr = new ConcurrencyManager(db, 1); // global limit 1, fully "occupied" by the stale slot

    // Without zombie cleanup this would be refused (1 + 1 > 1).
    expect(mgr.acquire('model-a', 5, 1)).toBe(true);

    const rows = allSlots(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pid).toBe(process.pid); // zombie removed, only the fresh slot remains
  });

  it('a slot held by a live pid is preserved (not swept as a zombie)', () => {
    // process.pid is guaranteed alive — stands in for "another live process holding a slot".
    insertSlot(db, 'model-b', process.pid, 1);
    const mgr = new ConcurrencyManager(db, 10);

    expect(mgr.acquire('model-a', 5, 1)).toBe(true);

    // Both the pre-existing live slot and the newly acquired one are present.
    expect(allSlots(db)).toHaveLength(2);
  });

  it('multiple zombie slots across different models are all swept in one acquire call', () => {
    insertSlot(db, 'model-a', DEAD_PID, 1);
    insertSlot(db, 'model-b', DEAD_PID, 1);
    insertSlot(db, 'model-c', DEAD_PID, 1);
    const mgr = new ConcurrencyManager(db, 10);

    expect(mgr.acquire('model-a', 5, 1)).toBe(true);

    const rows = allSlots(db);
    expect(rows).toHaveLength(1); // all three zombies gone, only the new slot remains
    expect(rows[0]!.pid).toBe(process.pid);
  });
});

describe('ConcurrencyManager.release', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(() => {
    closeDatabase(db);
  });

  it('removes all slots held by the current process', () => {
    const mgr = new ConcurrencyManager(db, 10);
    mgr.acquire('model-a', 5, 1);
    mgr.acquire('model-b', 5, 1);
    expect(allSlots(db)).toHaveLength(2);

    mgr.release();

    expect(allSlots(db)).toHaveLength(0);
  });

  it('does not touch slots held by other (still-live) pids', () => {
    // release() only filters by pid, with no zombie sweep — insert rows directly
    // (bypassing acquire(), which would sweep dead pids first) so this test isolates
    // release()'s own DELETE ... WHERE pid = ? behaviour.
    insertSlot(db, 'model-a', process.pid, 1);
    insertSlot(db, 'model-x', 1, 1); // pid 1 (init) is reliably alive — stands in for another live process
    const mgr = new ConcurrencyManager(db, 10);

    mgr.release();

    const rows = allSlots(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pid).toBe(1);
  });

  it('is a no-op when the process holds no slots', () => {
    const mgr = new ConcurrencyManager(db, 10);
    expect(() => mgr.release()).not.toThrow();
    expect(allSlots(db)).toHaveLength(0);
  });
});

describe('ConcurrencyManager.registerCleanup', () => {
  let db: Database.Database;
  let handlers: Record<string, (...args: unknown[]) => void>;

  beforeEach(() => {
    db = makeDb();
    handlers = {};
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
      return process;
    }) as unknown as typeof process.on);
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as unknown as typeof process.exit);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase(db);
  });

  it('the "exit" handler calls release() exactly once, even if the event fires twice', () => {
    const mgr = new ConcurrencyManager(db, 10);
    const releaseSpy = vi.spyOn(mgr, 'release').mockImplementation(() => {});

    mgr.registerCleanup();
    expect(handlers['exit']).toBeDefined();

    handlers['exit']!();
    handlers['exit']!(); // simulate the 'exit' event re-firing after a signal handler calls process.exit()

    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('the "SIGINT" handler releases slots and exits with code 130', () => {
    const mgr = new ConcurrencyManager(db, 10);
    const releaseSpy = vi.spyOn(mgr, 'release').mockImplementation(() => {});

    mgr.registerCleanup();
    expect(handlers['SIGINT']).toBeDefined();

    handlers['SIGINT']!();

    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(130);
  });

  it('the "SIGTERM" handler releases slots and exits with code 143', () => {
    const mgr = new ConcurrencyManager(db, 10);
    const releaseSpy = vi.spyOn(mgr, 'release').mockImplementation(() => {});

    mgr.registerCleanup();
    expect(handlers['SIGTERM']).toBeDefined();

    handlers['SIGTERM']!();

    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(process.exit).toHaveBeenCalledWith(143);
  });

  it('"exit" firing after a SIGINT-triggered cleanup does not release a second time', () => {
    const mgr = new ConcurrencyManager(db, 10);
    const releaseSpy = vi.spyOn(mgr, 'release').mockImplementation(() => {});

    mgr.registerCleanup();
    handlers['SIGINT']!();
    handlers['exit']!(); // Node re-fires 'exit' after process.exit() inside the SIGINT handler

    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });
});
