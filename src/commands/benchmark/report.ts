/**
 * Benchmark reporting — silent renderer plus ablation / release-gate /
 * error-rate output tables. Statistics computation lives in report-stats.ts
 * to keep this file thin (ARCH-03).
 */

import type { BenchmarkQuestion, BenchmarkResult, BenchmarkReport } from '../../types/benchmark.js';
import type { Session, Agent, DebatePhase, DegradationEvent, ConsensusResult } from '../../types/session.js';
import type { InvocationResult } from '../../types/provider.js';
import type { Renderer } from '../../types/renderer.js';
import {
  RELEASE_GATES,
  avgCoverageForCategory,
  avgErrorRateForCategory,
  groupQuestionsByCategory,
} from './report-stats.js';

export {
  extractResponse,
  computeSummary,
  buildDryRunReport,
} from './report-stats.js';

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

export function printDryRunTable(questions: BenchmarkQuestion[], report: BenchmarkReport): void {
  process.stdout.write('\nDry-run table (all scores = 0):\n');
  for (const q of questions) {
    process.stdout.write(`  ${q.id} (${q.category}): ${q.expected_points.length} points, ${q.known_traps.length} traps\n`);
  }
  process.stdout.write(`\nTotal: ${report.results.length} result slots\n`);
}

// ---------------------------------------------------------------------------
// Analysis output tables
// ---------------------------------------------------------------------------

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
