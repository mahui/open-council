import { initDatabase, closeDatabase } from '../storage/database.js';
import { PATHS } from '../config/paths.js';
import type { ApiErrorClass } from '../types/provider.js';

interface ProviderHealthRow {
  provider: string;
  status: string;
  consecutive_failures: number;
  last_failure_time: number;
  last_success_time: number;
  circuit_opened_at: number;
  throttle_ms: number;
}

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

const memoryStates = new Map<string, ProviderState>();

function getState(provider: string): ProviderState {
  let state = memoryStates.get(provider);
  if (!state) {
    const base = BASE_THROTTLE[provider] ?? 1000;
    
    // Load from DB
    try {
      const db = initDatabase(PATHS.database);
      let row: ProviderHealthRow | undefined;
      try {
        row = db.prepare('SELECT * FROM provider_health WHERE provider = ?').get(provider) as ProviderHealthRow | undefined;
      } finally {
        closeDatabase(db);
      }

      if (row) {
        state = {
          status: row.status as ProviderStatus,
          consecutiveFailures: row.consecutive_failures,
          lastFailureTime: row.last_failure_time,
          lastSuccessTime: row.last_success_time,
          throttleMs: row.throttle_ms,
          baseThrottleMs: base,
          circuitOpenedAt: row.circuit_opened_at,
          lastRequestTime: 0,
        };
      }
    } catch {
      // ignore
    }

    if (!state) {
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
    }
    memoryStates.set(provider, state);
  }
  return state;
}

function saveState(provider: string, state: ProviderState) {
  try {
    const db = initDatabase(PATHS.database);
    try {
      db.prepare(`
        INSERT OR REPLACE INTO provider_health (
          provider, status, consecutive_failures, last_failure_time,
          last_success_time, circuit_opened_at, throttle_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        provider, state.status, state.consecutiveFailures, state.lastFailureTime,
        state.lastSuccessTime, state.circuitOpenedAt, state.throttleMs,
      );
    } finally {
      closeDatabase(db);
    }
  } catch {
    // ignore
  }
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
  saveState(provider, state);
}

/**
 * Record a failed call against the circuit breaker.
 *
 * The `errorClass` reflects the *final* outcome as decided by the adapter:
 *  - `retryable` failures are only reported here after the adapter's in-line retries were
 *    exhausted, so a single transient blip that a retry absorbs never reaches the breaker
 *    (retries are consumed at the adapter layer, not accumulated as consecutive failures).
 *  - `timeout` and `permanent` (auth/param) failures are reported immediately.
 * All three count toward the consecutive-failure threshold: after CIRCUIT_BREAKER_THRESHOLD
 * genuine failures in a row we open the circuit and fall back to CLI. `CIRCUIT_BREAKER_THRESHOLD`
 * (3) is now measured in fully-retried invocations, which keeps it conservative but meaningful.
 *
 * `rateLimited` (a subset of `retryable`) additionally widens the adaptive throttle so we back
 * off the provider even while the circuit stays closed.
 */
export function recordFailure(
  provider: string,
  errorClass: ApiErrorClass,
  rateLimited = false,
): void {
  const state = getState(provider);
  state.consecutiveFailures++;
  state.lastFailureTime = Date.now();
  state.lastRequestTime = Date.now();

  if (rateLimited) {
    state.throttleMs = Math.min(MAX_THROTTLE_MS, Math.floor(state.throttleMs * 1.5));
    state.status = 'degraded';
  } else if (errorClass === 'retryable' || errorClass === 'timeout') {
    // Transient provider instability (5xx / network / hung) — mark degraded so the provider
    // is visibly flaky before the circuit fully opens. Permanent (auth/param) failures are
    // misconfiguration, not instability, so they still count but don't flag "degraded".
    state.status = 'degraded';
  }

  if (state.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    state.circuitOpenedAt = Date.now();
    state.status = 'open';
  }
  saveState(provider, state);
}

export function resetCircuitBreaker(provider: string): void {
  const state = getState(provider);
  state.status = 'healthy';
  state.consecutiveFailures = 0;
  state.circuitOpenedAt = 0;
  saveState(provider, state);
}

/** Get health summary for all tracked providers. */
export function getHealthSummary(): Array<{
  provider: string;
  status: ProviderStatus;
  failures: number;
  throttleMs: number;
}> {
  // Try to load all from DB
  try {
    const db = initDatabase(PATHS.database);
    let rows: ProviderHealthRow[] = [];
    try {
      rows = db.prepare('SELECT * FROM provider_health').all() as ProviderHealthRow[];
    } finally {
      closeDatabase(db);
    }

    for (const row of rows) {
      if (!memoryStates.has(row.provider)) {
        memoryStates.set(row.provider, {
          status: row.status as ProviderStatus,
          consecutiveFailures: row.consecutive_failures,
          lastFailureTime: row.last_failure_time,
          lastSuccessTime: row.last_success_time,
          throttleMs: row.throttle_ms,
          baseThrottleMs: BASE_THROTTLE[row.provider] ?? 1000,
          circuitOpenedAt: row.circuit_opened_at,
          lastRequestTime: 0,
        });
      }
    }
  } catch {
    // ignore
  }

  return [...memoryStates.entries()].map(([provider, state]) => {
    // Re-evaluate dynamic status based on time
    let effectiveStatus = state.status;
    if (state.circuitOpenedAt > 0) {
      const elapsed = Date.now() - state.circuitOpenedAt;
      effectiveStatus = elapsed < CIRCUIT_RECOVERY_MS ? 'open' : 'degraded';
    }
    
    return {
      provider,
      status: effectiveStatus,
      failures: state.consecutiveFailures,
      throttleMs: state.throttleMs,
    };
  });
}
