/**
 * Tests for classifyError / isRateLimit / extractStatus.
 *
 * Covers the three routes pi-ai errors reach us by: a raw SDK error object with a structured
 * status, a wrapped InvocationError whose message embeds the status/keywords, and network
 * error codes. Confirms the retry/permanent/timeout partition is correct.
 */
import { describe, it, expect } from 'vitest';
import { classifyError, isRateLimit, extractStatus } from '../../src/providers/error-classifier.js';
import { InvocationError, InvocationTimeoutError } from '../../src/types/errors.js';

describe('extractStatus', () => {
  it('reads .status from an SDK-style error object', () => {
    expect(extractStatus({ status: 429 })).toBe(429);
  });

  it('reads .statusCode', () => {
    expect(extractStatus({ statusCode: 503 })).toBe(503);
  });

  it('reads nested .response.status', () => {
    expect(extractStatus({ response: { status: 500 } })).toBe(500);
  });

  it('returns undefined when no status is present', () => {
    expect(extractStatus(new Error('boom'))).toBeUndefined();
    expect(extractStatus('a string')).toBeUndefined();
    expect(extractStatus(null)).toBeUndefined();
  });
});

describe('classifyError — timeout', () => {
  it('InvocationTimeoutError → timeout (never retried)', () => {
    expect(classifyError(new InvocationTimeoutError('gpt-x', 'api', 120))).toBe('timeout');
  });
});

describe('classifyError — retryable (structured status)', () => {
  it.each([429, 500, 502, 503, 504, 408])('status %i → retryable', (status) => {
    expect(classifyError({ status })).toBe('retryable');
  });
});

describe('classifyError — retryable (status embedded in message)', () => {
  it('leading "429 {...}" message → retryable', () => {
    expect(classifyError(new Error('429 {"type":"rate_limit_error"}'))).toBe('retryable');
  });

  it('parenthesised "(503)" message → retryable', () => {
    expect(
      classifyError(new InvocationError('gemini', 'api', 'Cloud Code Assist API error (503): unavailable')),
    ).toBe('retryable');
  });

  it('anthropic "Overloaded" (no status) → retryable', () => {
    expect(classifyError(new Error('Overloaded'))).toBe('retryable');
  });

  it('"rate limit exceeded" keyword → retryable', () => {
    expect(classifyError(new Error('Rate limit exceeded, try again'))).toBe('retryable');
  });
});

describe('classifyError — retryable (network codes)', () => {
  it.each(['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND'])(
    'err.code=%s → retryable',
    (code) => {
      const err = Object.assign(new Error('socket problem'), { code });
      expect(classifyError(err)).toBe('retryable');
    },
  );

  it('"fetch failed" message → retryable', () => {
    expect(classifyError(new Error('fetch failed'))).toBe('retryable');
  });
});

describe('classifyError — permanent', () => {
  it.each([400, 401, 403, 404, 422])('status %i → permanent', (status) => {
    expect(classifyError({ status })).toBe('permanent');
  });

  it('401 embedded in message → permanent', () => {
    expect(classifyError(new Error('401 {"error":"invalid api key"}'))).toBe('permanent');
  });

  it('"unauthorized" keyword → permanent', () => {
    expect(classifyError(new Error('Unauthorized: bad token'))).toBe('permanent');
  });

  it('"Model not found" resolution error → permanent', () => {
    expect(
      classifyError(new InvocationError('x', 'api', "Model 'x' not found in providers [openai]")),
    ).toBe('permanent');
  });

  it('permanent keyword wins over a generic retryable word', () => {
    // "unauthorized" must not be retried even if some transient-sounding word co-occurs.
    expect(classifyError(new Error('unauthorized — network context'))).toBe('permanent');
  });

  it('unknown error with no signal → permanent (fail fast to CLI)', () => {
    expect(classifyError(new Error('something weird happened'))).toBe('permanent');
  });
});

describe('isRateLimit', () => {
  it('status 429 object → true', () => {
    expect(isRateLimit({ status: 429 })).toBe(true);
  });

  it('"429" in message → true', () => {
    expect(isRateLimit(new Error('429 too many requests'))).toBe(true);
  });

  it('"overloaded" → true', () => {
    expect(isRateLimit(new Error('Overloaded'))).toBe(true);
  });

  it('503 (retryable but not rate limit) → false', () => {
    expect(isRateLimit({ status: 503 })).toBe(false);
  });

  it('permanent auth error → false', () => {
    expect(isRateLimit(new Error('unauthorized'))).toBe(false);
  });
});
