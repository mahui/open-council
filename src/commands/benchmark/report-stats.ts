/**
 * Benchmark statistics — response extraction, release-gate thresholds,
 * per-category coverage/error-rate aggregation and summary computation.
 * Pure functions with no output side effects (ARCH-03 split from report.ts).
 */

import type { BenchmarkQuestion, BenchmarkResult, BenchmarkReport } from '../../types/benchmark.js';
import type { Session } from '../../types/session.js';

// ---------------------------------------------------------------------------
// Response extraction from a completed session
// ---------------------------------------------------------------------------

export function extractResponse(session: Session): string {
  if (session.synthesis) return session.synthesis;

  const broadcastStage = session.stages.find(s => s.phase === 'broadcast');
  const first = broadcastStage?.invocations.find(inv => !inv.timed_out && inv.response_raw);
  return first?.response_raw ?? '';
}

// ---------------------------------------------------------------------------
// Release gate thresholds (D vs B, coverage delta)
// ---------------------------------------------------------------------------

export const RELEASE_GATES: Record<string, { coverage: number; errorRate: number }> = {
  architecture: { coverage: 0.20, errorRate: 0.30 },
  code:         { coverage: 0.10, errorRate: 0.20 },
  security:     { coverage: 0.25, errorRate: 0.40 },
  general:      { coverage: 0.15, errorRate: 0.25 },
};

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

export type GroupLabel =
  | 'A best-single-quick'
  | 'B best-single-deep'
  | 'C compare+synthesis'
  | 'D full-debate';

function avgCoverage(results: BenchmarkResult[], mode: GroupLabel, category?: string): number {
  const filtered = results.filter(r =>
    r.mode === mode && (category === undefined || true),
  );
  if (filtered.length === 0) return 0;
  return filtered.reduce((s, r) => s + r.coverage_score, 0) / filtered.length;
}

export function avgCoverageForCategory(
  results: BenchmarkResult[],
  questionIds: string[],
  mode: GroupLabel,
): number {
  const filtered = results.filter(r => questionIds.includes(r.question_id) && r.mode === mode);
  if (filtered.length === 0) return 0;
  return filtered.reduce((s, r) => s + r.coverage_score, 0) / filtered.length;
}

export function avgErrorRateForCategory(
  results: BenchmarkResult[],
  questionIds: string[],
  mode: GroupLabel,
): number {
  const filtered = results.filter(r => questionIds.includes(r.question_id) && r.mode === mode);
  if (filtered.length === 0) return 0;
  // error_score = 1 - error_rate, so error_rate = 1 - error_score
  const avgScore = filtered.reduce((s, r) => s + r.error_score, 0) / filtered.length;
  return 1 - avgScore;
}

export function groupQuestionsByCategory(questions: BenchmarkQuestion[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const q of questions) {
    (map[q.category] ??= []).push(q.id);
  }
  return map;
}

export function computeSummary(results: BenchmarkResult[]): BenchmarkReport['summary'] {
  if (results.length === 0) {
    return { avg_coverage: 0, avg_error_rate: 0, total_elapsed_ms: 0 };
  }
  const avg_coverage = results.reduce((s, r) => s + r.coverage_score, 0) / results.length;
  const avg_error_rate = results.reduce((s, r) => s + (1 - r.error_score), 0) / results.length;
  const total_elapsed_ms = results.reduce((s, r) => s + r.elapsed_ms, 0);
  return { avg_coverage, avg_error_rate, total_elapsed_ms };
}

// ---------------------------------------------------------------------------
// Dry-run report construction
// ---------------------------------------------------------------------------

export function buildDryRunReport(questions: BenchmarkQuestion[]): BenchmarkReport {
  const results: BenchmarkResult[] = [];
  const groups = ['A best-single-quick', 'B best-single-deep', 'C compare+synthesis', 'D full-debate'];
  for (const q of questions) {
    for (const mode of groups) {
      results.push({ question_id: q.id, mode, coverage_score: 0, error_score: 0, elapsed_ms: 0, models_used: [] });
    }
  }
  return {
    run_id: `bench_${Date.now()}`,
    timestamp: new Date().toISOString(),
    results,
    summary: { avg_coverage: 0, avg_error_rate: 0, total_elapsed_ms: 0 },
  };
}

// Suppress unused-variable warning: avgCoverage is a utility that may be
// used by future callers; keep it to avoid re-implementation.
void avgCoverage;
