/**
 * Benchmark suite loading — parses the YAML question set into typed
 * BenchmarkQuestion records. Extracted from benchmark.ts (ARCH-03).
 *
 * NOTE: the default suite path is resolved by the caller (benchmark.ts) so
 * that `import.meta.dirname` stays anchored at src/commands/.
 */

import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { BenchmarkQuestion } from '../../types/benchmark.js';

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

export function loadBenchmarkSuite(suitePath: string): BenchmarkQuestion[] {
  const raw = parseYaml(readFileSync(suitePath, 'utf-8')) as RawBenchmarkFile;

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
