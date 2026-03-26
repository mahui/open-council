/**
 * council history / council show <id> / council recall <keyword>
 * Thin CLI layer — business logic delegated to SessionStore (ARCH-03).
 */

import { SessionStore } from '../storage/session-store.js';
import { PATHS } from '../config/paths.js';
import type { Session } from '../types/session.js';

function formatDate(iso: string): string {
  return iso.replace('T', ' ').slice(0, 19);
}

function ratingStars(rating: number | undefined): string {
  if (rating == null) return 'unrated';
  return '*'.repeat(rating) + ' '.repeat(5 - rating);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + '...';
}

export async function runHistory(options: { limit?: string; mode?: string }): Promise<void> {
  const store = new SessionStore(PATHS.sessionsDir);
  const limit = options.limit ? parseInt(options.limit, 10) : 20;
  const sessions = await store.listSessions({ limit, mode: options.mode });

  if (sessions.length === 0) {
    process.stderr.write('No debate sessions found.\n');
    return;
  }

  process.stdout.write('\nDebate History:\n');
  process.stdout.write('-'.repeat(80) + '\n');

  for (const s of sessions) {
    const date = formatDate(s.created_at);
    const mode = s.resolved_mode.padEnd(7);
    const status = s.status.padEnd(12);
    const rating = ratingStars(s.user_rating);
    const q = truncate(s.question, 50);
    process.stdout.write(
      `  ${s.session_id.slice(0, 8)}  ${date}  [${mode}] ${status}  ${rating}  ${q}\n`,
    );
  }

  process.stdout.write(`\n  ${sessions.length} session(s) shown.\n\n`);
}

export async function runShow(sessionId: string): Promise<void> {
  const store = new SessionStore(PATHS.sessionsDir);
  const session = await store.getSession(sessionId);

  if (!session) {
    process.stderr.write(`Session not found: ${sessionId}\n`);
    process.exit(1);
  }

  printSessionDetail(session);
}

export async function runRecall(keyword: string): Promise<void> {
  const store = new SessionStore(PATHS.sessionsDir);
  const all = await store.listSessions({ limit: 500 });
  const lowerKw = keyword.toLowerCase();

  const matches = all.filter(s => {
    const haystack = [
      s.question,
      s.synthesis ?? '',
      ...(s.tags ?? []),
    ].join(' ').toLowerCase();
    return haystack.includes(lowerKw);
  });

  if (matches.length === 0) {
    process.stderr.write(`No debates found matching "${keyword}".\n`);
    return;
  }

  process.stdout.write(`\nFound ${matches.length} related debate(s):\n`);
  process.stdout.write('-'.repeat(60) + '\n');

  for (const s of matches.slice(0, 20)) {
    const date = formatDate(s.created_at);
    const rating = ratingStars(s.user_rating);
    process.stdout.write(`  [${date}] "${truncate(s.question, 50)}"\n`);
    process.stdout.write(`    Rating: ${rating}  Mode: ${s.resolved_mode}\n`);
    if (s.synthesis) {
      process.stdout.write(`    Summary: ${truncate(s.synthesis, 80)}\n`);
    }
    process.stdout.write('\n');
  }
}

function printSessionDetail(s: Session): void {
  process.stdout.write(`\nSession: ${s.session_id}\n`);
  process.stdout.write('='.repeat(60) + '\n');
  process.stdout.write(`Question: ${s.question}\n`);
  process.stdout.write(`Mode: ${s.resolved_mode}  Status: ${s.status}\n`);
  process.stdout.write(`Created: ${formatDate(s.created_at)}\n`);
  if (s.completed_at) process.stdout.write(`Completed: ${formatDate(s.completed_at)}\n`);
  if (s.total_elapsed_ms != null) process.stdout.write(`Duration: ${s.total_elapsed_ms}ms\n`);
  if (s.user_rating != null) process.stdout.write(`Rating: ${ratingStars(s.user_rating)}\n`);
  if (s.tags?.length) process.stdout.write(`Tags: ${s.tags.join(', ')}\n`);

  process.stdout.write('\n--- Agents ---\n');
  for (const a of s.agents) {
    const chair = a.is_chairman ? ' [Chairman]' : '';
    process.stdout.write(`  ${a.agent_id}: ${a.config.name} (${a.role})${chair}\n`);
  }

  for (const stage of s.stages) {
    process.stdout.write(`\n--- ${stage.phase} (${stage.status}) ---\n`);
    for (const inv of stage.invocations) {
      process.stdout.write(`  [${inv.role}] ${inv.model_name}:\n`);
      process.stdout.write(`    ${truncate(inv.result.response, 200)}\n`);
    }
  }

  if (s.synthesis) {
    process.stdout.write('\n--- Synthesis ---\n');
    process.stdout.write(s.synthesis + '\n');
  }

  if (s.consensus) {
    process.stdout.write(`\nConsensus score: ${s.consensus.consensus_score}\n`);
  }
  process.stdout.write('\n');
}
