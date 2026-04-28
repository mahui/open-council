/**
 * Benchmark type definitions.
 * Pure types — no runtime code (ARCH-04).
 */

export interface BenchmarkTrap {
  type: string;
  description: string;
}

export interface BenchmarkQuestion {
  id: string;
  category: string;
  question: string;
  expected_points: string[];
  /** Flat strings, kept for backwards-compat display. */
  error_traps: string[];
  /** Structured traps used by the evaluator. */
  known_traps: BenchmarkTrap[];
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface BenchmarkResult {
  question_id: string;
  mode: string;
  coverage_score: number;
  error_score: number;
  elapsed_ms: number;
  models_used: string[];
}

export interface BenchmarkReport {
  run_id: string;
  timestamp: string;
  results: BenchmarkResult[];
  summary: {
    avg_coverage: number;
    avg_error_rate: number;
    total_elapsed_ms: number;
  };
}
