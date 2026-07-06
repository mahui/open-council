/**
 * council benchmark — Run four-group ablation benchmark experiments.
 * Thin CLI layer; suite loading, experiment execution and reporting live in
 * src/commands/benchmark/*, evaluation logic in src/core/evaluator.ts (ARCH-03).
 */

import { join } from 'node:path';
import type { ModelConfig } from '../types/config.js';
import type { BenchmarkReport } from '../types/benchmark.js';
import { Orchestrator } from '../core/orchestrator.js';
import { resolveDefaultsDir } from '../shared/resources.js';
import { buildAdapter, resolveModels } from './shared/assemble.js';
import { loadBenchmarkSuite } from './benchmark/suite.js';
import { runExperiments } from './benchmark/runner.js';
import {
  SilentRenderer,
  printBanner,
  printAblationAnalysis,
  printReleaseGate,
  printErrorRateSummary,
  computeSummary,
  buildDryRunReport,
  printDryRunTable,
} from './benchmark/report.js';

export interface BenchmarkOptions {
  suite?: string;
  json?: boolean;
  dryRun?: boolean;
}

export async function runBenchmark(options: BenchmarkOptions): Promise<void> {
  const suitePath = options.suite
    ?? join(resolveDefaultsDir(), 'benchmark.yaml');
  const questions = loadBenchmarkSuite(suitePath);
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
  const { models: allModels } = resolveModels();

  if (allModels.length === 0) {
    process.stderr.write(
      'Error: No models available. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY.\n',
    );
    process.exit(1);
  }

  // Best model = highest priority (sort descending, take first)
  const bestModel: ModelConfig = [...allModels].sort((a, b) => b.priority - a.priority)[0]!;

  const adapter = buildAdapter();
  // Single orchestrator; model filtering is handled per run via RunOptions.models
  const orchestrator = new Orchestrator(adapter, new SilentRenderer(), allModels);

  // --- Run ---
  const date = new Date().toISOString().slice(0, 10);
  printBanner(date);
  process.stdout.write(`Running ${questions.length} questions × 4 groups...\n\n`);

  const allResults = await runExperiments(questions, orchestrator, adapter, bestModel);

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
