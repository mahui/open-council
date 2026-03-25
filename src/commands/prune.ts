/**
 * council prune — Clean up old session data.
 * Thin CLI layer (ARCH-03).
 */

import { SessionStore } from '../storage/session-store.js';
import { PATHS } from '../config/paths.js';
import type { Session } from '../types/session.js';

interface PruneOptions {
  before?: string;
  dryRun?: boolean;
}

function parseDate(dateStr: string): Date | null {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  return d;
}

function defaultCutoff(): Date {
  const d = new Date();
  d.setDate(d.getDate() - 90);
  return d;
}

function shouldPrune(session: Session, cutoff: Date): boolean {
  const created = new Date(session.created_at);
  return created < cutoff;
}

export async function runPrune(options: PruneOptions): Promise<void> {
  const cutoff = options.before ? parseDate(options.before) : defaultCutoff();

  if (!cutoff) {
    process.stderr.write(
      `Invalid date: "${options.before}". Use ISO format, e.g. 2025-01-01.\n`,
    );
    process.exit(1);
  }

  const store = new SessionStore(PATHS.sessionsDir);
  const sessions = await store.listSessions({ limit: 10000 });

  const toPrune = sessions.filter(s => shouldPrune(s, cutoff));

  if (toPrune.length === 0) {
    process.stderr.write(
      `No sessions older than ${cutoff.toISOString().slice(0, 10)}.\n`,
    );
    return;
  }

  if (options.dryRun) {
    process.stderr.write(`Would prune ${toPrune.length} session(s):\n`);
    for (const s of toPrune) {
      process.stderr.write(
        `  ${s.session_id.slice(0, 8)}  ${s.created_at.slice(0, 10)}  "${s.question.slice(0, 50)}"\n`,
      );
    }
    return;
  }

  let deleted = 0;
  for (const s of toPrune) {
    await store.deleteSession(s.session_id);
    deleted++;
  }

  process.stdout.write(`Pruned ${deleted} session(s) older than ${cutoff.toISOString().slice(0, 10)}.\n`);
}
