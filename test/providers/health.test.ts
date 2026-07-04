/**
 * Tests for the circuit breaker's recordFailure classification semantics.
 *
 * The DB layer is mocked so initDatabase throws — health.ts swallows that and operates on its
 * in-memory state map, letting us assert breaker/throttle behaviour without touching SQLite.
 * Each test uses a unique provider name because memoryStates is module-level and persists.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/storage/database.js', () => ({
  initDatabase: vi.fn(() => { throw new Error('no db in unit test'); }),
  closeDatabase: vi.fn(),
}));

import {
  recordFailure,
  recordSuccess,
  getProviderStatus,
  getHealthSummary,
  resetCircuitBreaker,
  throttle,
} from '../../src/providers/health.js';

function summaryFor(provider: string): { status: string; failures: number; throttleMs: number } {
  const row = getHealthSummary().find((s) => s.provider === provider);
  if (!row) throw new Error(`no summary for ${provider}`);
  return row;
}

let counter = 0;
function uniqueProvider(): string {
  return `test-provider-${counter++}`;
}

describe('recordFailure — classification semantics', () => {
  it('permanent failure counts toward the breaker but does not flag "degraded"', () => {
    const p = uniqueProvider();
    recordFailure(p, 'permanent', false);

    const s = summaryFor(p);
    expect(s.failures).toBe(1);
    // Not degraded — a permanent (auth/param) error is misconfiguration, not provider flakiness.
    expect(s.status).toBe('healthy');
  });

  it('retryable failure flags the provider as degraded', () => {
    const p = uniqueProvider();
    recordFailure(p, 'retryable', false);

    expect(summaryFor(p).status).toBe('degraded');
  });

  it('timeout failure flags the provider as degraded', () => {
    const p = uniqueProvider();
    recordFailure(p, 'timeout', false);

    expect(summaryFor(p).status).toBe('degraded');
  });

  it('rateLimited=true widens the adaptive throttle', () => {
    const p = uniqueProvider();
    // Unknown provider defaults to a 1000ms base throttle; a rate-limited failure grows it ×1.5.
    recordFailure(p, 'retryable', true);

    expect(summaryFor(p).throttleMs).toBeGreaterThan(1000);
    expect(summaryFor(p).status).toBe('degraded');
  });

  it('three consecutive failures open the circuit (regardless of class)', () => {
    const p = uniqueProvider();
    recordFailure(p, 'retryable', false);
    expect(getProviderStatus(p)).not.toBe('open');
    recordFailure(p, 'permanent', false);
    expect(getProviderStatus(p)).not.toBe('open');
    recordFailure(p, 'timeout', false);

    // Threshold (3) reached → circuit open, API is skipped in favour of CLI.
    expect(getProviderStatus(p)).toBe('open');
  });

  it('recordSuccess resets consecutive failures and closes the circuit', () => {
    const p = uniqueProvider();
    recordFailure(p, 'retryable', false);
    recordFailure(p, 'retryable', false);
    recordFailure(p, 'retryable', false);
    expect(getProviderStatus(p)).toBe('open');

    recordSuccess(p);

    expect(getProviderStatus(p)).toBe('healthy');
    expect(summaryFor(p).failures).toBe(0);
  });
});

describe('circuit breaker recovery cycle — open → half-open → closed/reopened', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function openCircuit(p: string): void {
    recordFailure(p, 'retryable', false);
    recordFailure(p, 'retryable', false);
    recordFailure(p, 'retryable', false);
  }

  it('circuit remains fully open right up until CIRCUIT_RECOVERY_MS elapses', () => {
    vi.useFakeTimers();
    const p = uniqueProvider();
    openCircuit(p);
    expect(getProviderStatus(p)).toBe('open');

    vi.advanceTimersByTime(59_000);
    expect(getProviderStatus(p)).toBe('open');
  });

  it('circuit transitions to half-open ("degraded") once CIRCUIT_RECOVERY_MS has elapsed', () => {
    vi.useFakeTimers();
    const p = uniqueProvider();
    openCircuit(p);
    expect(getProviderStatus(p)).toBe('open');

    vi.advanceTimersByTime(60_001);
    expect(getProviderStatus(p)).toBe('degraded');
  });

  it('getHealthSummary mirrors the same open → half-open transition over time', () => {
    vi.useFakeTimers();
    const p = uniqueProvider();
    openCircuit(p);
    expect(summaryFor(p).status).toBe('open');

    vi.advanceTimersByTime(60_001);
    expect(summaryFor(p).status).toBe('degraded');
  });

  it('a success while half-open closes the circuit fully (back to healthy)', () => {
    vi.useFakeTimers();
    const p = uniqueProvider();
    openCircuit(p);
    vi.advanceTimersByTime(60_001);
    expect(getProviderStatus(p)).toBe('degraded'); // half-open probe window

    recordSuccess(p);

    expect(getProviderStatus(p)).toBe('healthy');
  });

  it('a failure during the half-open probe reopens the circuit and restarts the recovery timer', () => {
    vi.useFakeTimers();
    const p = uniqueProvider();
    openCircuit(p);
    vi.advanceTimersByTime(60_001);
    expect(getProviderStatus(p)).toBe('degraded'); // half-open probe window

    recordFailure(p, 'retryable', false); // the probe attempt itself fails

    expect(getProviderStatus(p)).toBe('open'); // reopened immediately
    vi.advanceTimersByTime(59_000);
    expect(getProviderStatus(p)).toBe('open'); // recovery timer restarted from the reopen point
  });
});

describe('resetCircuitBreaker', () => {
  it('manually closes an open circuit and clears the failure count', () => {
    const p = uniqueProvider();
    recordFailure(p, 'retryable', false);
    recordFailure(p, 'retryable', false);
    recordFailure(p, 'retryable', false);
    expect(getProviderStatus(p)).toBe('open');

    resetCircuitBreaker(p);

    expect(getProviderStatus(p)).toBe('healthy');
    expect(summaryFor(p).failures).toBe(0);
  });
});

describe('recordSuccess — adaptive throttle decay', () => {
  it('lowers the throttle by 20% per success but floors at the provider base throttle', () => {
    const p = uniqueProvider(); // unknown provider → base throttle defaults to 1000ms
    recordFailure(p, 'retryable', true); // widen beyond base
    const widened = summaryFor(p).throttleMs;
    expect(widened).toBeGreaterThan(1000);

    recordSuccess(p);
    const afterOneSuccess = summaryFor(p).throttleMs;
    expect(afterOneSuccess).toBeLessThan(widened);
    expect(afterOneSuccess).toBeGreaterThanOrEqual(1000);

    // Repeated successes converge to, but never dip below, the base throttle.
    for (let i = 0; i < 10; i++) recordSuccess(p);
    expect(summaryFor(p).throttleMs).toBe(1000);
  });

  it('known provider "anthropic" decays back to its own low base (500ms), not the generic default', () => {
    recordFailure('anthropic', 'retryable', true);
    expect(summaryFor('anthropic').throttleMs).toBeGreaterThan(500);

    for (let i = 0; i < 10; i++) recordSuccess('anthropic');

    expect(summaryFor('anthropic').throttleMs).toBe(500);
  });
});

describe('recordFailure — adaptive throttle ceiling', () => {
  it('rateLimited failures cap the throttle at MAX_THROTTLE_MS (30s), never exceeding it', () => {
    const p = uniqueProvider();
    for (let i = 0; i < 20; i++) {
      recordFailure(p, 'retryable', true);
    }

    expect(summaryFor(p).throttleMs).toBe(30_000);
  });
});

describe('throttle', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('the first call for a fresh provider resolves immediately (no prior request to wait out)', async () => {
    vi.useFakeTimers();
    const p = uniqueProvider();

    let resolved = false;
    const p1 = throttle(p).then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(0);

    expect(resolved).toBe(true);
    await p1;
  });

  it('a second call issued immediately after the first waits out the remaining throttle window', async () => {
    vi.useFakeTimers();
    const p = uniqueProvider(); // unknown provider → 1000ms base throttle
    await throttle(p); // establishes lastRequestTime

    let resolved = false;
    const second = throttle(p).then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(resolved).toBe(true);
    await second;
  });
});
