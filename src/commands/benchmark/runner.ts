/**
 * Benchmark experiment runner — executes the four ablation groups per question
 * and evaluates coverage / error scores. Extracted from benchmark.ts (ARCH-03).
 */

import type { BenchmarkQuestion, BenchmarkResult } from '../../types/benchmark.js';
import type { ModelConfig } from '../../types/config.js';
import type { DebateMode, RunOptions } from '../../types/session.js';
import type { Orchestrator } from '../../core/orchestrator.js';
import type { AutoAdapter } from '../../providers/adapter.js';
import { evaluateCoverage, evaluateErrors } from '../../core/evaluator.js';
import { extractResponse } from './report.js';

interface GroupConfig {
  label: string;
  mode: DebateMode;
  modelFilter?: string[];
}

function pad(s: string, w: number): string {
  return s.padEnd(w);
}

function fmt(n: number, decimals = 0): string {
  return (n * 100).toFixed(decimals) + '%';
}

/**
 * Run all questions × four groups, printing per-group progress to stdout and
 * returning the accumulated results.
 */
export async function runExperiments(
  questions: BenchmarkQuestion[],
  orchestrator: Orchestrator,
  adapter: AutoAdapter,
  bestModel: ModelConfig,
): Promise<BenchmarkResult[]> {
  const allResults: BenchmarkResult[] = [];

  for (let qi = 0; qi < questions.length; qi++) {
    const q = questions[qi]!;
    const shortQ = q.question.length > 40 ? q.question.slice(0, 40) + '...' : q.question;
    process.stdout.write(`[${qi + 1}/${questions.length}] ${q.id} (${q.category})  ${shortQ}\n`);

    const groupConfigs: GroupConfig[] = [
      { label: 'A best-single-quick',   mode: 'quick',   modelFilter: [bestModel.name] },
      { label: 'B best-single-deep',    mode: 'compare', modelFilter: [bestModel.name] },
      { label: 'C compare+synthesis',   mode: 'compare' },
      { label: 'D full-debate',         mode: 'debate' },
    ];

    for (const group of groupConfigs) {
      const result = await runGroup(q, group, orchestrator, adapter, bestModel);
      allResults.push(result);
    }
    process.stdout.write('\n');
  }

  return allResults;
}

async function runGroup(
  q: BenchmarkQuestion,
  group: GroupConfig,
  orchestrator: Orchestrator,
  adapter: AutoAdapter,
  bestModel: ModelConfig,
): Promise<BenchmarkResult> {
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
        evaluateErrors(q.question, response, q.known_traps, adapter, bestModel),
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

  return {
    question_id: q.id,
    mode: group.label,
    coverage_score: coverageScore,
    error_score: errorScore,
    elapsed_ms: elapsed,
    models_used: modelsUsed,
  };
}
