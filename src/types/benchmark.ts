/**
 * Benchmark type definitions.
 * Pure types — no runtime code (ARCH-04).
 */

export interface BenchmarkQuestion {
  id: string;
  category: string;
  question: string;
  expected_points: string[];
  error_traps: string[];
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
