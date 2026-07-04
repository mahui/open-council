import type Database from 'better-sqlite3';

export class ConcurrencyManager {
  constructor(private db: Database.Database, private globalLimit: number) {}

  /**
   * Try to acquire a resource slot.
   * Uses SQLite BEGIN IMMEDIATE for atomicity.
   * Synchronous API guarantees no yield within transaction.
   */
  acquire(modelId: string, maxConcurrent: number, resourceWeight: number): boolean {
    const txn = this.db.transaction(() => {
      // 1. Clean zombie slots
      const slots = this.db.prepare('SELECT slot_id, pid FROM resource_slots').all() as Array<{ slot_id: number; pid: number }>;
      for (const slot of slots) {
        if (!isProcessAlive(slot.pid)) {
          this.db.prepare('DELETE FROM resource_slots WHERE slot_id = ?').run(slot.slot_id);
        }
      }

      // 2. Check per-model concurrency limit
      const modelCount = this.db.prepare(
        'SELECT COUNT(*) as cnt FROM resource_slots WHERE model_id = ?',
      ).get(modelId) as { cnt: number };

      if (modelCount.cnt >= maxConcurrent) return false;

      // 3. Check global resource pool
      const totalCost = this.db.prepare(
        'SELECT COALESCE(SUM(resource_cost), 0) as total FROM resource_slots',
      ).get() as { total: number };

      if (totalCost.total + resourceWeight > this.globalLimit) return false;

      // 4. Insert slot
      this.db.prepare(
        'INSERT INTO resource_slots (model_id, pid, acquired_at, resource_cost) VALUES (?, ?, ?, ?)',
      ).run(modelId, process.pid, new Date().toISOString(), resourceWeight);

      return true;
    });

    return txn.immediate();
  }

  /** Release all slots held by current process */
  release(): void {
    this.db.prepare('DELETE FROM resource_slots WHERE pid = ?').run(process.pid);
  }

  /** Register automatic cleanup on process exit */
  registerCleanup(): void {
    // Signal handlers run cleanup then exit, which re-fires the 'exit' event and
    // would invoke cleanup a second time. Guard with an idempotency flag so the
    // slot release happens exactly once.
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      this.release();
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(130); });
    process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we lack permission to signal it —
    // that is still "alive". Only ESRCH (no such process) means dead.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EPERM') {
      return true;
    }
    return false;
  }
}
