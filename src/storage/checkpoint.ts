import { readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Session } from '../types/session.js';
import { safePath } from '../providers/utils.js';

/** Checkpoints are retained for recovery; only stale ones past this age are purged. */
const CHECKPOINT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

interface CheckpointData extends Session {
  pid: number;
  last_updated_at: string;
}

export class CheckpointManager {
  constructor(private checkpointDir: string) {
    mkdirSync(this.checkpointDir, { recursive: true });
  }

  save(session: Session): void {
    const path = this.getPath(session.session_id);
    const data: CheckpointData = {
      ...session,
      pid: process.pid,
      last_updated_at: new Date().toISOString(),
    };
    // Atomic write: write to a temp file in the same dir, then rename over the
    // target. A crash mid-write leaves the temp file (later cleaned) untouched,
    // never a truncated primary checkpoint.
    const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmpPath, path);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* temp may not exist */ }
      throw err;
    }
  }

  restore(sessionId?: string): Session | null {
    this.cleanStale();

    if (sessionId) {
      return this.loadCheckpoint(this.getPath(sessionId));
    }

    // Find most recent valid checkpoint
    if (!existsSync(this.checkpointDir)) return null;

    const files = readdirSync(this.checkpointDir)
      .filter(f => f.endsWith('.ckpt.json'))
      .map(f => ({
        name: f,
        path: join(this.checkpointDir, f),
        mtime: statSync(join(this.checkpointDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const file of files) {
      const session = this.loadCheckpoint(file.path);
      if (session) return session;
    }

    return null;
  }

  remove(sessionId: string): void {
    const path = this.getPath(sessionId);
    try { unlinkSync(path); } catch { /* file may not exist */ }
  }

  /**
   * Remove checkpoints that are safe to discard: already completed, or older
   * than the retention window. A dead originating PID is NOT a cleanup signal —
   * a crashed run's checkpoint is precisely the recovery target, so PID liveness
   * is intentionally decoupled from cleanup to avoid the self-destruct bug where
   * restore() erased the checkpoint it was about to load.
   */
  private cleanStale(): void {
    if (!existsSync(this.checkpointDir)) return;

    const files = readdirSync(this.checkpointDir).filter(f => f.endsWith('.ckpt.json'));

    for (const file of files) {
      const path = join(this.checkpointDir, file);
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8')) as CheckpointData;
        const age = Date.now() - new Date(data.last_updated_at).getTime();
        const isCompleted = data.status === 'completed';

        if (isCompleted || age > CHECKPOINT_RETENTION_MS) {
          unlinkSync(path);
        }
      } catch {
        // Parse failure (e.g. truncated/corrupt) — safe to discard.
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    }
  }

  private loadCheckpoint(path: string): Session | null {
    if (!existsSync(path)) return null;
    try {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as CheckpointData;
      // Strip checkpoint-specific fields
      const { pid: _pid, last_updated_at: _ts, ...session } = data;
      return session;
    } catch {
      return null;
    }
  }

  private getPath(sessionId: string): string {
    return safePath(this.checkpointDir, `${sessionId}.ckpt.json`);
  }
}
