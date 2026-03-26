/**
 * council rate <sessionId> <score> — Add user rating to a session.
 * Thin CLI layer (ARCH-03).
 */

import { SessionStore } from '../storage/session-store.js';
import { PATHS } from '../config/paths.js';

export async function runRate(sessionId: string, scoreStr: string): Promise<void> {
  const score = parseInt(scoreStr, 10);

  if (isNaN(score) || score < 1 || score > 5) {
    process.stderr.write('Error: Score must be an integer between 1 and 5.\n');
    process.exit(1);
  }

  const store = new SessionStore(PATHS.sessionsDir);
  const session = await store.getSession(sessionId);

  if (!session) {
    process.stderr.write(`Session not found: ${sessionId}\n`);
    process.exit(1);
  }

  session.user_rating = score;
  await store.saveSession(session);

  const stars = '*'.repeat(score);
  process.stdout.write(`Rated session ${sessionId.slice(0, 8)} : ${stars} (${score}/5)\n`);
}
