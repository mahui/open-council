/**
 * council replay <sessionId> — Replay a debate session stage by stage.
 * Zero token consumption: reads from persisted session data.
 * Thin CLI layer (ARCH-03).
 */

import { SessionStore } from '../storage/session-store.js';
import { PATHS } from '../config/paths.js';
import type { Session, Stage } from '../types/session.js';

function formatDate(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

function printStage(stage: Stage, index: number, total: number): void {
  process.stdout.write(`\n[${ index + 1}/${total}] Phase: ${stage.phase} (${stage.status})\n`);
  process.stdout.write('-'.repeat(50) + '\n');

  if (stage.started_at) {
    process.stdout.write(`  Started:   ${formatDate(stage.started_at)}\n`);
  }
  if (stage.completed_at) {
    process.stdout.write(`  Completed: ${formatDate(stage.completed_at)}\n`);
  }

  for (const inv of stage.invocations) {
    process.stdout.write(`\n  [${inv.role}] ${inv.model_name}`);
    if (inv.timed_out) {
      process.stdout.write(' (TIMED OUT)');
    }
    process.stdout.write(`  (${inv.result.elapsed_ms}ms)\n`);
    process.stdout.write(`  ${'-'.repeat(40)}\n`);

    const lines = inv.result.response.split('\n');
    for (const line of lines) {
      process.stdout.write(`  ${line}\n`);
    }
  }
}

function printSession(session: Session): void {
  process.stdout.write('\n');
  process.stdout.write('='.repeat(60) + '\n');
  process.stdout.write(`Replaying: ${session.session_id}\n`);
  process.stdout.write(`Question: ${session.question}\n`);
  process.stdout.write(`Mode: ${session.resolved_mode}  Status: ${session.status}\n`);
  process.stdout.write('='.repeat(60) + '\n');

  const total = session.stages.length;
  for (const [i, stage] of session.stages.entries()) {
    printStage(stage, i, total);
  }

  if (session.synthesis) {
    process.stdout.write('\n' + '='.repeat(60) + '\n');
    process.stdout.write('SYNTHESIS:\n');
    process.stdout.write('='.repeat(60) + '\n');
    process.stdout.write(session.synthesis + '\n');
  }

  if (session.consensus) {
    process.stdout.write(`\nConsensus score: ${session.consensus.consensus_score}\n`);
  }

  if (session.degradation_events?.length) {
    process.stdout.write('\nDegradation events:\n');
    for (const ev of session.degradation_events) {
      process.stdout.write(`  - [${ev.phase}] ${ev.reason}: ${ev.impact}\n`);
    }
  }

  process.stdout.write('\n--- Replay complete ---\n\n');
}

export async function runReplay(sessionId: string): Promise<void> {
  const store = new SessionStore(PATHS.sessionsDir);
  const session = await store.getSession(sessionId);

  if (!session) {
    process.stderr.write(`Session not found: ${sessionId}\n`);
    process.exit(1);
  }

  printSession(session);
}
