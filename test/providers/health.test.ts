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
