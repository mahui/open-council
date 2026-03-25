import type { ModelConfig } from '../types/config.js';
import type { HealthStatus } from '../types/provider.js';

/**
 * Health check levels:
 * - L1: Binary exists (CLI) / Credential exists (API)
 * - L2: Version check (CLI) / Token validity (API) — Phase 4
 * - L3: Test invocation — Phase 4
 */

export interface HealthChecker {
  check(config: ModelConfig): Promise<HealthStatus>;
}

// Placeholder for Phase 4 circuit breaker
export interface CircuitBreakerState {
  model_id: string;
  failure_count: number;
  last_failure_at?: string;
  is_open: boolean;
  recovery_at?: string;
}
