/**
 * Provider health manager — circuit breaker + adaptive throttle.
 *
 * Tracks per-provider failure history and adapts:
 * - Circuit breaker: after N consecutive failures, skip API → go straight to CLI
 * - Adaptive throttle: increase wait time after 429s, decrease after successes
 */

export type ProviderStatus = 'healthy' | 'degraded' | 'open';

interface ProviderState {
  status: ProviderStatus;
  consecutiveFailures: number;
  lastFailureTime: number;
  lastSuccessTime: number;
  throttleMs: number;
  baseThrottleMs: number;
  circuitOpenedAt: number;
  lastRequestTime: number;
}

const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_RECOVERY_MS = 60_000;
const MAX_THROTTLE_MS = 30_000;

const BASE_THROTTLE: Record<string, number> = {
  google: 12_000,
  anthropic: 500,
  openai: 500,
};

const states = new Map<string, ProviderState>();

function getState(provider: string): ProviderState {
  let state = states.get(provider);
  if (!state) {
    const base = BASE_THROTTLE[provider] ?? 1000;
    state = {
      status: 'healthy',
      consecutiveFailures: 0,
      lastFailureTime: 0,
      lastSuccessTime: 0,
      throttleMs: base,
      baseThrottleMs: base,
      circuitOpenedAt: 0,
      lastRequestTime: 0,
    };
    states.set(provider, state);
  }
  return state;
}

/** Check circuit breaker status. 'open' = skip API, go straight to CLI. */
export function getProviderStatus(provider: string): ProviderStatus {
  const state = getState(provider);
  if (state.circuitOpenedAt > 0) {
    const elapsed = Date.now() - state.circuitOpenedAt;
    if (elapsed < CIRCUIT_RECOVERY_MS) return 'open';
    return 'degraded'; // half-open: allow one attempt
  }
  return state.status;
}

/** Wait for adaptive throttle before making a request. */
export async function throttle(provider: string): Promise<void> {
  const state = getState(provider);
  const elapsed = Date.now() - state.lastRequestTime;
  const waitMs = Math.max(0, state.throttleMs - elapsed);
  if (waitMs > 0) {
    await new Promise(r => setTimeout(r, waitMs));
  }
  state.lastRequestTime = Date.now();
}

/** Record successful call. Resets circuit breaker, gradually lowers throttle. */
export function recordSuccess(provider: string): void {
  const state = getState(provider);
  state.consecutiveFailures = 0;
  state.lastSuccessTime = Date.now();
  state.lastRequestTime = Date.now();
  state.status = 'healthy';
  state.circuitOpenedAt = 0;
  state.throttleMs = Math.max(state.baseThrottleMs, Math.floor(state.throttleMs * 0.8));
}

/** Record failed call. Opens circuit after threshold, increases throttle for 429. */
export function recordFailure(provider: string, is429: boolean): void {
  const state = getState(provider);
  state.consecutiveFailures++;
  state.lastFailureTime = Date.now();
  state.lastRequestTime = Date.now();

  if (is429) {
    state.throttleMs = Math.min(MAX_THROTTLE_MS, Math.floor(state.throttleMs * 1.5));
    state.status = 'degraded';
  }

  if (state.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    state.circuitOpenedAt = Date.now();
    state.status = 'open';
  }
}

/** Get health summary for all tracked providers. */
export function getHealthSummary(): Array<{
  provider: string;
  status: ProviderStatus;
  failures: number;
  throttleMs: number;
}> {
  return [...states.entries()].map(([provider, state]) => ({
    provider,
    status: getProviderStatus(provider),
    failures: state.consecutiveFailures,
    throttleMs: state.throttleMs,
  }));
}
