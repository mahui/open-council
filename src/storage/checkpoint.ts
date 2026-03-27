import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../types/session.js';
import { safePath } from '../providers/utils.js';

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
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  restore(sessionId?: string): Session | null {
    this.cleanOrphans();

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

  /** Clean checkpoints older than 24h or whose PID has exited */
  private cleanOrphans(): void {
    if (!existsSync(this.checkpointDir)) return;

    const maxAge = 24 * 60 * 60 * 1000;
    const files = readdirSync(this.checkpointDir).filter(f => f.endsWith('.ckpt.json'));

    for (const file of files) {
      const path = join(this.checkpointDir, file);
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8')) as CheckpointData;
        const age = Date.now() - new Date(data.last_updated_at).getTime();
        const pidAlive = isProcessAlive(data.pid);

        if (age > maxAge || !pidAlive) {
          unlinkSync(path);
        }
      } catch {
        // Parse failure — also clean up
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
