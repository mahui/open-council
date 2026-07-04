/**
 * Benchmark reporting — silent renderer, response extraction, ablation /
 * release-gate / error-rate analysis, dry-run tables and summary computation.
 * Extracted from benchmark.ts to keep the command file thin (ARCH-03).
 */

import type { BenchmarkQuestion, BenchmarkResult, BenchmarkReport } from '../../types/benchmark.js';
import type { Session, Agent, DebatePhase, DegradationEvent, ConsensusResult } from '../../types/session.js';
import type { InvocationResult } from '../../types/provider.js';
import type { Renderer } from '../../ui/renderer.js';

// ---------------------------------------------------------------------------
// Silent renderer — suppresses all debate progress output during benchmark
// ---------------------------------------------------------------------------

export class SilentRenderer implements Renderer {
  onPhaseStart(_phase: DebatePhase, _index: number, _total: number): void {}
  onAgentStart(_agent: Agent): void {}
  onAgentProgress(_agent: Agent, _chunk: string): void {}
  onAgentComplete(_agent: Agent, _result: InvocationResult): void {}
  onConsensus(_result: ConsensusResult): void {}
  onDegradation(_event: DegradationEvent): void {}
  renderResult(_session: Session): void {}
}

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

const RELEASE_GATES: Record<string, { coverage: number; errorRate: number }> = {
  architecture: { coverage: 0.20, errorRate: 0.30 },
  code:         { coverage: 0.10, errorRate: 0.20 },
  security:     { coverage: 0.25, errorRate: 0.40 },
  general:      { coverage: 0.15, errorRate: 0.25 },
};

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

const BANNER_WIDTH = 64;

function fmt(n: number, decimals = 0): string {
  return (n * 100).toFixed(decimals) + '%';
}

function pad(s: string, w: number): string {
  return s.padEnd(w);
}

export function printBanner(date: string): void {
  const title = `Council Benchmark  —  ${date}`;
  process.stdout.write('╔' + '═'.repeat(BANNER_WIDTH - 2) + '╗\n');
  process.stdout.write('║  ' + title.padEnd(BANNER_WIDTH - 4) + '  ║\n');
  process.stdout.write('╚' + '═'.repeat(BANNER_WIDTH - 2) + '╝\n\n');
}

// ---------------------------------------------------------------------------
// Dry-run helpers
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

export function printDryRunTable(questions: BenchmarkQuestion[], report: BenchmarkReport): void {
  process.stdout.write('\nDry-run table (all scores = 0):\n');
  for (const q of questions) {
    process.stdout.write(`  ${q.id} (${q.category}): ${q.expected_points.length} points, ${q.known_traps.length} traps\n`);
  }
  process.stdout.write(`\nTotal: ${report.results.length} result slots\n`);
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

type GroupLabel = 'A best-single-quick' | 'B best-single-deep' | 'C compare+synthesis' | 'D full-debate';

function avgCoverage(results: BenchmarkResult[], mode: GroupLabel, category?: string): number {
  const filtered = results.filter(r =>
    r.mode === mode && (category === undefined || true),
  );
  if (filtered.length === 0) return 0;
  return filtered.reduce((s, r) => s + r.coverage_score, 0) / filtered.length;
}

function avgCoverageForCategory(
  results: BenchmarkResult[],
  questionIds: string[],
  mode: GroupLabel,
): number {
  const filtered = results.filter(r => questionIds.includes(r.question_id) && r.mode === mode);
  if (filtered.length === 0) return 0;
  return filtered.reduce((s, r) => s + r.coverage_score, 0) / filtered.length;
}

function avgErrorRateForCategory(
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

function groupQuestionsByCategory(questions: BenchmarkQuestion[]): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const q of questions) {
    (map[q.category] ??= []).push(q.id);
  }
  return map;
}

export function printAblationAnalysis(questions: BenchmarkQuestion[], results: BenchmarkResult[]): void {
  process.stdout.write('─'.repeat(BANNER_WIDTH) + '\n\n');
  process.stdout.write('Ablation Analysis\n');

  const byCategory = groupQuestionsByCategory(questions);
  for (const [cat, ids] of Object.entries(byCategory)) {
    const a = avgCoverageForCategory(results, ids, 'A best-single-quick');
    const b = avgCoverageForCategory(results, ids, 'B best-single-deep');
    const c = avgCoverageForCategory(results, ids, 'C compare+synthesis');
    const d = avgCoverageForCategory(results, ids, 'D full-debate');

    const ab = b - a;
    const bc = c - b;
    const cd = d - c;

    const sign = (v: number): string => (v >= 0 ? '+' : '') + fmt(v);
    process.stdout.write(
      `  ${pad(cat, 14)} A→B (prompt): ${pad(sign(ab), 6)}  ` +
      `B→C (multi): ${pad(sign(bc), 6)}  ` +
      `C→D (review): ${sign(cd)}\n`,
    );
  }
  process.stdout.write('\n');
}

export function printReleaseGate(questions: BenchmarkQuestion[], results: BenchmarkResult[]): void {
  process.stdout.write('Release Gate  (full-debate vs best-single-deep)\n');

  const byCategory = groupQuestionsByCategory(questions);
  let allPassed = true;

  for (const [cat, ids] of Object.entries(byCategory)) {
    const gate = RELEASE_GATES[cat] ?? { coverage: 0.15, errorRate: 0.25 };

    const bCov  = avgCoverageForCategory(results, ids, 'B best-single-deep');
    const dCov  = avgCoverageForCategory(results, ids, 'D full-debate');
    const bErr  = avgErrorRateForCategory(results, ids, 'B best-single-deep');
    const dErr  = avgErrorRateForCategory(results, ids, 'D full-debate');

    const deltaCov = dCov - bCov;
    const deltaErr = bErr - dErr; // positive = fewer errors in D

    const covPassed = deltaCov >= gate.coverage;
    const errPassed = deltaErr >= gate.errorRate;
    const passed = covPassed && errPassed;
    if (!passed) allPassed = false;

    const mark = passed ? '✓' : '✗';
    process.stdout.write(
      `  ${pad(cat, 14)} Δcoverage: ${pad((deltaCov >= 0 ? '+' : '') + fmt(deltaCov), 6)} ${covPassed ? '✓' : '✗'}` +
      `  target ${fmt(gate.coverage)}` +
      `  Δerrors: ${pad((deltaErr >= 0 ? '+' : '') + fmt(deltaErr), 6)} ${errPassed ? '✓' : '✗'}` +
      `  target ${fmt(gate.errorRate)}\n`,
    );
    void mark;
  }

  process.stdout.write(`  Result: ${allPassed ? '✓ PASSED' : '✗ FAILED'}\n\n`);
}

export function printErrorRateSummary(questions: BenchmarkQuestion[], results: BenchmarkResult[]): void {
  process.stdout.write('Error Rate Summary  (lower = better)\n');
  process.stdout.write('                     A       B       C       D\n');

  const byCategory = groupQuestionsByCategory(questions);
  for (const [cat, ids] of Object.entries(byCategory)) {
    const a = avgErrorRateForCategory(results, ids, 'A best-single-quick');
    const b = avgErrorRateForCategory(results, ids, 'B best-single-deep');
    const c = avgErrorRateForCategory(results, ids, 'C compare+synthesis');
    const d = avgErrorRateForCategory(results, ids, 'D full-debate');

    process.stdout.write(
      `  ${pad(cat, 16)} ${fmt(a).padStart(6)}  ${fmt(b).padStart(6)}  ${fmt(c).padStart(6)}  ${fmt(d).padStart(6)}\n`,
    );
  }
  process.stdout.write('\n');
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

// Suppress unused-variable warning: avgCoverage is a utility that may be
// used by future callers; keep it to avoid re-implementation.
void avgCoverage;
