/**
 * council benchmark — Run ablation benchmark experiments.
 * Loads questions from defaults/benchmark.yaml and runs 4-group comparisons.
 * Thin CLI layer (ARCH-03). Actual orchestration delegated to core.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { BenchmarkQuestion, BenchmarkResult, BenchmarkReport } from '../types/benchmark.js';

interface BenchmarkOptions {
  suite?: string;
  json?: boolean;
  dryRun?: boolean;
}

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

const GROUPS = [
  'best-single-quick',
  'best-single-deep',
  'compare+synthesis',
  'full-debate',
] as const;

function loadBenchmarkSuite(suitePath?: string): BenchmarkQuestion[] {
  const path = suitePath
    ?? join(import.meta.dirname, '..', '..', 'defaults', 'benchmark.yaml');
  const raw = parseYaml(readFileSync(path, 'utf-8')) as RawBenchmarkFile;

  return raw.questions.map((q): BenchmarkQuestion => ({
    id: q.id,
    category: q.category,
    question: q.question,
    expected_points: q.expected_points,
    error_traps: q.known_traps.map(t => `[${t.type}] ${t.description}`),
    difficulty: inferDifficulty(q.expected_points.length),
  }));
}

function inferDifficulty(pointCount: number): 'easy' | 'medium' | 'hard' {
  if (pointCount <= 3) return 'easy';
  if (pointCount <= 5) return 'medium';
  return 'hard';
}

function printTable(results: Map<string, BenchmarkResult[]>): void {
  const header =
    '  ' +
    'Question'.padEnd(20) +
    GROUPS.map(g => g.padStart(20)).join('') +
    '\n';

  process.stdout.write('\nBenchmark Results (Coverage %)\n');
  process.stdout.write('='.repeat(100) + '\n');
  process.stdout.write(header);
  process.stdout.write('-'.repeat(100) + '\n');

  for (const [qid, groupResults] of results.entries()) {
    const cols = groupResults.map(
      r => `${(r.coverage_score * 100).toFixed(0)}% / ${(r.error_score * 100).toFixed(0)}%`,
    );
    process.stdout.write(
      '  ' + qid.padEnd(20) + cols.map(c => c.padStart(20)).join('') + '\n',
    );
  }

  process.stdout.write('\n');
}

function buildDryRunReport(questions: BenchmarkQuestion[]): BenchmarkReport {
  const results: BenchmarkResult[] = [];
  for (const q of questions) {
    for (const mode of GROUPS) {
      results.push({
        question_id: q.id,
        mode,
        coverage_score: 0,
        error_score: 0,
        elapsed_ms: 0,
        models_used: [],
      });
    }
  }

  return {
    run_id: `bench_${Date.now()}`,
    timestamp: new Date().toISOString(),
    results,
    summary: { avg_coverage: 0, avg_error_rate: 0, total_elapsed_ms: 0 },
  };
}

export async function runBenchmark(options: BenchmarkOptions): Promise<void> {
  const questions = loadBenchmarkSuite(options.suite);
  process.stderr.write(`Loaded ${questions.length} benchmark question(s).\n`);

  if (options.dryRun) {
    process.stderr.write('Dry run: skipping actual model invocations.\n');
    const report = buildDryRunReport(questions);

    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }

    const grouped = new Map<string, BenchmarkResult[]>();
    for (const q of questions) {
      grouped.set(q.id, report.results.filter(r => r.question_id === q.id));
    }
    printTable(grouped);
    return;
  }

  // Full benchmark requires orchestrator integration (Phase 3+).
  // Placeholder: report that live benchmark is not yet wired.
  process.stderr.write(
    'Live benchmark execution requires orchestrator integration.\n' +
    'Use --dry-run to validate the benchmark suite.\n',
  );
}
