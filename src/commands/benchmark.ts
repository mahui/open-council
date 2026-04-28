/**
 * council benchmark — Run four-group ablation benchmark experiments.
 * Thin CLI layer; evaluation logic lives in src/core/evaluator.ts (ARCH-03).
 * Max ~200 lines enforced by keeping formatting helpers minimal.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { BenchmarkQuestion, BenchmarkResult, BenchmarkReport } from '../types/benchmark.js';
import type { ModelConfig } from '../types/config.js';
import type { DebateMode, RunOptions, Session, Agent, DebatePhase, DegradationEvent, ConsensusResult } from '../types/session.js';
import type { InvocationResult } from '../types/provider.js';
import type { Renderer } from '../ui/renderer.js';
import { Orchestrator } from '../core/orchestrator.js';
import { evaluateCoverage, evaluateErrors } from '../core/evaluator.js';
import { AutoAdapter } from '../providers/adapter.js';
import { ApiAdapter } from '../providers/api-adapter.js';
import { CliAdapter } from '../providers/cli-adapter.js';
import { CredentialManager } from '../providers/credentials/discovery.js';
import { ConfigLoader } from '../config/loader.js';
import { discoverModelsFromEnv } from '../config/presets.js';

// ---------------------------------------------------------------------------
// CLI options
// ---------------------------------------------------------------------------

export interface BenchmarkOptions {
  suite?: string;
  json?: boolean;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// YAML loading
// ---------------------------------------------------------------------------

interface RawQuestion {
  id: string;
  category: string;
  question: string;
  expected_points: string[];
  known_traps: Array<{ type: string; description: string }>;
}

interface RawBenchmarkFile {
  version: string;
  questions: RawQuestion[];
}

function loadBenchmarkSuite(suitePath?: string): BenchmarkQuestion[] {
  const path = suitePath
    ?? join(import.meta.dirname, '..', '..', 'defaults', 'benchmark.yaml');
  const raw = parseYaml(readFileSync(path, 'utf-8')) as RawBenchmarkFile;

  return raw.questions.map((q): BenchmarkQuestion => ({
    id: q.id,
    category: q.category,
    question: q.question,
    expected_points: q.expected_points,
    known_traps: q.known_traps,
    error_traps: q.known_traps.map(t => `[${t.type}] ${t.description}`),
    difficulty: inferDifficulty(q.expected_points.length),
  }));
}

function inferDifficulty(pointCount: number): 'easy' | 'medium' | 'hard' {
  if (pointCount <= 3) return 'easy';
  if (pointCount <= 5) return 'medium';
  return 'hard';
}

// ---------------------------------------------------------------------------
// Silent renderer — suppresses all debate progress output during benchmark
// ---------------------------------------------------------------------------

class SilentRenderer implements Renderer {
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

function extractResponse(session: Session): string {
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

function printBanner(date: string): void {
  const title = `Council Benchmark  —  ${date}`;
  process.stdout.write('\u2554' + '\u2550'.repeat(BANNER_WIDTH - 2) + '\u2557\n');
  process.stdout.write('\u2551  ' + title.padEnd(BANNER_WIDTH - 4) + '  \u2551\n');
  process.stdout.write('\u255a' + '\u2550'.repeat(BANNER_WIDTH - 2) + '\u255d\n\n');
}

// ---------------------------------------------------------------------------
// Main benchmark runner
// ---------------------------------------------------------------------------

export async function runBenchmark(options: BenchmarkOptions): Promise<void> {
  const questions = loadBenchmarkSuite(options.suite);
  process.stderr.write(`Loaded ${questions.length} benchmark question(s).\n`);

  if (options.dryRun) {
    process.stderr.write('Dry run: skipping actual model invocations.\n');
    const report = buildDryRunReport(questions);
    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      printDryRunTable(questions, report);
    }
    return;
  }

  // --- Model discovery ---
  const credentialManager = new CredentialManager();
  await credentialManager.discoverAll();

  let allModels: ModelConfig[];
  const loader = new ConfigLoader();
  if (loader.isConfigured()) {
    try {
      allModels = loader.loadAllModels();
    } catch {
      allModels = discoverModelsFromEnv(credentialManager);
    }
  } else {
    allModels = discoverModelsFromEnv(credentialManager);
  }

  if (allModels.length === 0) {
    process.stderr.write(
      'Error: No models available. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.\n',
    );
    process.exit(1);
  }

  // Best model = highest priority (sort descending, take first)
  const sorted = [...allModels].sort((a, b) => b.priority - a.priority);
  const bestModel = sorted[0]!;

  const apiAdapter = new ApiAdapter(credentialManager);
  const cliAdapter = new CliAdapter();
  const adapter = new AutoAdapter(apiAdapter, cliAdapter);
  const silentRenderer = new SilentRenderer();

  // Single orchestrator; model filtering is handled per run via RunOptions.models
  const orchestrator = new Orchestrator(adapter, silentRenderer, allModels);

  // --- Run ---
  const date = new Date().toISOString().slice(0, 10);
  printBanner(date);
  process.stdout.write(`Running ${questions.length} questions \u00d7 4 groups...\n\n`);

  const allResults: BenchmarkResult[] = [];

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]!;
    const shortQ = q.question.length > 40 ? q.question.slice(0, 40) + '...' : q.question;
    process.stdout.write(`[${qi + 1}/${questions.length}] ${q.id} (${q.category})  ${shortQ}\n`);

    const groupConfigs: Array<{ label: string; mode: DebateMode; modelFilter?: string[] }> = [
      { label: 'A best-single-quick',   mode: 'quick',   modelFilter: [bestModel.name] },
      { label: 'B best-single-deep',    mode: 'compare', modelFilter: [bestModel.name] },
      { label: 'C compare+synthesis',   mode: 'compare' },
      { label: 'D full-debate',         mode: 'debate' },
    ];

    for (const group of groupConfigs) {
      const t0 = Date.now();
      let coverageScore = 0;
      let errorScore = 0;
      let modelsUsed: string[] = [];
      let failed = false;

      try {
        const runOpts: RunOptions = {
          mode: group.mode,
          models: group.modelFilter,
          noStore: true,
        };
        const session = await orchestrator.run(q.question, runOpts);
        modelsUsed = [...new Set(session.agents.map(a => a.config.name))];

        const response = extractResponse(session);
        if (!response) {
          failed = true;
        } else {
          const [covResult, errResult] = await Promise.all([
            evaluateCoverage(q.question, response, q.expected_points, adapter, bestModel),
            evaluateErrors(q.question, response, q.known_traps as Array<{ type: string; description: string }>, adapter, bestModel),
          ]);
          coverageScore = covResult.score;
          errorScore = errResult.errorScore;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`  Warning: group ${group.label} failed: ${msg}\n`);
        failed = true;
      }

      const elapsed = Date.now() - t0;
      const trapCount = q.known_traps.length;
      const errorsTriggered = Math.round((1 - errorScore) * trapCount);
      const flag = failed ? ' [failed]' : '';

      process.stdout.write(
        `  ${pad(group.label, 26)} coverage: ${fmt(coverageScore)}` +
        `  errors: ${errorsTriggered}/${trapCount}` +
        `  ${(elapsed / 1000).toFixed(1)}s${flag}\n`,
      );

      allResults.push({
        question_id: q.id,
        mode: group.label,
        coverage_score: coverageScore,
        error_score: errorScore,
        elapsed_ms: elapsed,
        models_used: modelsUsed,
      });
    }
    process.stdout.write('\n');
  }

  // --- Summaries ---
  printAblationAnalysis(questions, allResults);
  printReleaseGate(questions, allResults);
  printErrorRateSummary(questions, allResults);

  if (options.json) {
    const report: BenchmarkReport = {
      run_id: `bench_${Date.now()}`,
      timestamp: new Date().toISOString(),
      results: allResults,
      summary: computeSummary(allResults),
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
}

// ---------------------------------------------------------------------------
// Dry-run helpers
// ---------------------------------------------------------------------------

function buildDryRunReport(questions: BenchmarkQuestion[]): BenchmarkReport {
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

function printDryRunTable(questions: BenchmarkQuestion[], report: BenchmarkReport): void {
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

function printAblationAnalysis(questions: BenchmarkQuestion[], results: BenchmarkResult[]): void {
  process.stdout.write('\u2500'.repeat(BANNER_WIDTH) + '\n\n');
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
      `  ${pad(cat, 14)} A\u2192B (prompt): ${pad(sign(ab), 6)}  ` +
      `B\u2192C (multi): ${pad(sign(bc), 6)}  ` +
      `C\u2192D (review): ${sign(cd)}\n`,
    );
  }
  process.stdout.write('\n');
}

function printReleaseGate(questions: BenchmarkQuestion[], results: BenchmarkResult[]): void {
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

    const mark = passed ? '\u2713' : '\u2717';
    process.stdout.write(
      `  ${pad(cat, 14)} \u0394coverage: ${pad((deltaCov >= 0 ? '+' : '') + fmt(deltaCov), 6)} ${covPassed ? '\u2713' : '\u2717'}` +
      `  target ${fmt(gate.coverage)}` +
      `  \u0394errors: ${pad((deltaErr >= 0 ? '+' : '') + fmt(deltaErr), 6)} ${errPassed ? '\u2713' : '\u2717'}` +
      `  target ${fmt(gate.errorRate)}\n`,
    );
    void mark;
  }

  process.stdout.write(`  Result: ${allPassed ? '\u2713 PASSED' : '\u2717 FAILED'}\n\n`);
}

function printErrorRateSummary(questions: BenchmarkQuestion[], results: BenchmarkResult[]): void {
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

function computeSummary(results: BenchmarkResult[]): BenchmarkReport['summary'] {
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
