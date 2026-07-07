/**
 * Provider, Credential, InvocationResult type definitions.
 * Pure types — no runtime code (ARCH-04).
 */

import type { ModelConfig } from './config.js';

/**
 * How a model response was produced. Always 'api' for new records; 'cli' survives
 * only when reading sessions persisted before the standard-API convergence
 * (TDD §invocation_mode, review-2 P1-1). Canonical single source for this union —
 * every DTO/state/error field referencing it aliases here rather than re-spelling
 * the literal union.
 */
export type InvocationMode = 'cli' | 'api';

export interface InvocationResult {
  response: string;
  elapsed_ms: number;
  invocation_mode: InvocationMode;
  exit_code?: number;
  http_status?: number;
  stderr?: string;
  token_usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  timed_out: boolean;
  /**
   * The response was cut off by the model's max_tokens / length limit (API finish_reason
   * `length`). Orthogonal to `timed_out`: `timed_out` means the call never completed in time
   * (content may be empty), whereas `truncated` means the call completed with real, usable
   * content that was clipped mid-way. Optional — absent/undefined ≡ not truncated.
   */
  truncated?: boolean;
}

export interface HealthStatus {
  level: 'healthy' | 'unhealthy' | 'degraded' | 'unavailable';
  message: string;
  checked_at: string;
}

export type OnChunk = (chunk: string) => void;

/**
 * Classification of an API invocation failure, used to decide retry behaviour and
 * how the failure feeds the circuit breaker.
 * - `retryable`: transient (429, 5xx, provider overloaded, network reset) — worth an
 *   exponential-backoff retry before giving up.
 * - `permanent`: caller-side (401/403 auth, 400/404/422 bad request) — retrying cannot help.
 * - `timeout`: the call exceeded its deadline; already burned a lot of wall-clock, so not retried.
 */
export type ApiErrorClass = 'retryable' | 'permanent' | 'timeout';

export interface InvocationAdapter {
  invoke(config: ModelConfig, prompt: string, onChunk?: OnChunk): Promise<InvocationResult>;
  healthCheck(config: ModelConfig): Promise<HealthStatus>;
}

export type CredentialStatus = 'valid' | 'refreshed' | 'expired' | 'not_found' | 'parse_error';

export interface DiscoveryResult {
  source: 'env' | 'file';
  status: CredentialStatus;
  path?: string;
  env_var?: string;
}

export type DiscoveryReport = Record<string, DiscoveryResult>;
