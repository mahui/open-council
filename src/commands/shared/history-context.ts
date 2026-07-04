/**
 * Historical context resolution for the council command — searches past
 * sessions to (a) offer reuse of a high-confidence match in TTY mode and
 * (b) inject medium-confidence matches as broadcast context. Extracted from
 * council.ts to keep the command file thin (ARCH-03).
 */

import { confirm } from '@inquirer/prompts';
import type { SessionStore } from '../../storage/session-store.js';
import { PlainRenderer } from '../../ui/plain-renderer.js';
import { offerViewer } from '../../ui/interactive.js';

export interface HistoryContextOptions {
  noStore?: boolean;
  json?: boolean;
}

export interface HistoryContextResult {
  /** Medium-confidence prior conclusions to inject as broadcast context. */
  historicalContext?: string;
  /** True when the user chose to reuse a past synthesis — caller should stop. */
  reused: boolean;
}

export async function resolveHistoricalContext(
  store: SessionStore,
  question: string,
  options: HistoryContextOptions,
): Promise<HistoryContextResult> {
  if (options.noStore) return { reused: false };

  try {
    const similar = await store.searchSimilar(question, 3);
    const completed = similar.filter(s => s.status === 'completed' && s.synthesis);

    // In TTY mode: offer to reuse a high-confidence (≥ 0.8) match
    if (process.stderr.isTTY && !options.json) {
      const bestMatch = completed.find(s => (s.consensus?.consensus_score ?? 0) >= 0.8);
      if (bestMatch) {
        process.stderr.write(`\n\x1b[36m💡 Found highly similar past debate (Consensus: ${bestMatch.consensus!.consensus_score.toFixed(2)})\x1b[0m\n`);
        process.stderr.write(`\x1b[2mQuestion: ${bestMatch.question.substring(0, 100)}...\x1b[0m\n`);

        const reuse = await confirm({ message: 'Would you like to review the historical synthesis instead of running a new debate?' });
        if (reuse) {
          process.stderr.write('\n');
          new PlainRenderer().renderResult(bestMatch);
          await offerViewer(bestMatch);
          return { reused: true };
        }
      }
    }

    // Always (TTY or not): silently inject medium-confidence (≥ 0.6) matches as broadcast context
    const contextSessions = completed.filter(s => (s.consensus?.consensus_score ?? 0) >= 0.6);
    if (contextSessions.length > 0) {
      const parts = contextSessions.slice(0, 2).map(
        s => `Q: "${s.question.substring(0, 120)}"\nConclusion: ${s.synthesis!.substring(0, 400)}`,
      );
      const historicalContext = parts.join('\n\n---\n\n');
      if (process.stderr.isTTY && !options.json) {
        process.stderr.write(
          `\x1b[2m💡 Found ${contextSessions.length} related past debate(s) — injecting as context\x1b[0m\n`,
        );
      }
      return { reused: false, historicalContext };
    }
  } catch {
    // ignore FTS search errors
  }

  return { reused: false };
}
