/**
 * council stats — Model performance statistics.
 * Thin CLI layer (ARCH-03). Reads sessions from SessionStore.
 */

import { SessionStore } from '../storage/session-store.js';
import { PATHS } from '../config/paths.js';
import type { Session } from '../types/session.js';

interface ModelStats {
  invocations: number;
  totalElapsedMs: number;
  successes: number;
  failures: number;
  timeouts: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

function collectStats(sessions: Session[]): Map<string, ModelStats> {
  const map = new Map<string, ModelStats>();

  for (const session of sessions) {
    for (const stage of session.stages) {
      for (const inv of stage.invocations) {
        let entry = map.get(inv.model_name);
        if (!entry) {
          entry = {
            invocations: 0,
            totalElapsedMs: 0,
            successes: 0,
            failures: 0,
            timeouts: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
          };
          map.set(inv.model_name, entry);
        }
        entry.invocations++;
        entry.totalElapsedMs += inv.result.elapsed_ms;
        if (inv.timed_out) {
          entry.timeouts++;
        } else if (inv.result.response.length > 0) {
          entry.successes++;
        } else {
          entry.failures++;
        }
        if (inv.result.token_usage) {
          entry.totalInputTokens += inv.result.token_usage.input_tokens;
          entry.totalOutputTokens += inv.result.token_usage.output_tokens;
        }
      }
    }
  }

  return map;
}

function computeRatingStats(sessions: Session[]): { count: number; avg: number } {
  const rated = sessions.filter(s => s.user_rating != null);
  if (rated.length === 0) return { count: 0, avg: 0 };
  const sum = rated.reduce((acc, s) => acc + (s.user_rating ?? 0), 0);
  return { count: rated.length, avg: sum / rated.length };
}

export async function runStats(options: { json?: boolean }): Promise<void> {
  const store = new SessionStore(PATHS.sessionsDir);
  const sessions = await store.listSessions({ limit: 1000 });

  if (sessions.length === 0) {
    process.stderr.write('No sessions found. Run some debates first.\n');
    return;
  }

  const modelStats = collectStats(sessions);
  const ratingStats = computeRatingStats(sessions);

  if (options.json) {
    const output = {
      total_sessions: sessions.length,
      rating: ratingStats,
      models: Object.fromEntries(
        [...modelStats.entries()].map(([name, s]) => [name, {
          invocations: s.invocations,
          avg_elapsed_ms: Math.round(s.totalElapsedMs / s.invocations),
          success_rate: s.invocations > 0
            ? Math.round((s.successes / s.invocations) * 100)
            : 0,
          timeouts: s.timeouts,
          total_tokens: s.totalInputTokens + s.totalOutputTokens,
        }]),
      ),
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }

  process.stdout.write('\nCouncil Statistics\n');
  process.stdout.write('='.repeat(60) + '\n');
  process.stdout.write(`Total sessions: ${sessions.length}\n`);
  if (ratingStats.count > 0) {
    process.stdout.write(`Avg user rating: ${ratingStats.avg.toFixed(1)} (${ratingStats.count} rated)\n`);
  }

  process.stdout.write('\nModel Performance:\n');
  process.stdout.write('-'.repeat(60) + '\n');
  process.stdout.write(
    '  ' +
    'Model'.padEnd(22) +
    'Calls'.padStart(6) +
    'Avg ms'.padStart(8) +
    'Success'.padStart(9) +
    'Timeouts'.padStart(9) +
    'Tokens'.padStart(10) +
    '\n',
  );
  process.stdout.write('-'.repeat(60) + '\n');

  for (const [name, s] of modelStats.entries()) {
    const avgMs = Math.round(s.totalElapsedMs / s.invocations);
    const successRate = s.invocations > 0
      ? `${Math.round((s.successes / s.invocations) * 100)}%`
      : 'N/A';
    const tokens = s.totalInputTokens + s.totalOutputTokens;
    process.stdout.write(
      '  ' +
      name.padEnd(22) +
      String(s.invocations).padStart(6) +
      String(avgMs).padStart(8) +
      successRate.padStart(9) +
      String(s.timeouts).padStart(9) +
      String(tokens).padStart(10) +
      '\n',
    );
  }

  process.stdout.write('\n');
}
