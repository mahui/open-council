/**
 * Tests for the boundary-prefix matcher in src/shared/match.ts, used by the API
 * adapter's registry disambiguation and the core role-generator's LLM-returned
 * model-name resolution to decide whether a shorter id is a genuine version-
 * prefix of a longer one (vs. an unrelated or mid-token substring match).
 *
 * Pure, zero-dependency string logic — no mocking, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { isPrefixAtBoundary } from '../../src/shared/match.js';

describe('isPrefixAtBoundary — separator-terminated prefixes', () => {
  it('a "-" separator after the prefix is a boundary', () => {
    expect(isPrefixAtBoundary('gpt-5-mini', 'gpt-5')).toBe(true);
  });

  it('a "." separator after the prefix is a boundary', () => {
    expect(isPrefixAtBoundary('gpt-5.1', 'gpt-5')).toBe(true);
  });
});

describe('isPrefixAtBoundary — letter→digit version bump', () => {
  it('a letter followed directly by a digit is a boundary (implicit version bump)', () => {
    expect(isPrefixAtBoundary('gpt4', 'gpt')).toBe(true);
  });
});

describe('isPrefixAtBoundary — rejected (non-boundary) cases', () => {
  it('a letter appended with no separator is NOT a boundary (gpt-4 must not swallow gpt-4o)', () => {
    expect(isPrefixAtBoundary('gpt-4o', 'gpt-4')).toBe(false);
  });

  it('a digit→digit run is the same number, not a boundary (gpt-5 must not swallow gpt-50)', () => {
    expect(isPrefixAtBoundary('gpt-50', 'gpt-5')).toBe(false);
  });

  it('another digit→digit run case (gpt-4 must not swallow gpt-40)', () => {
    expect(isPrefixAtBoundary('gpt-40', 'gpt-4')).toBe(false);
  });

  it('longer does not actually start with prefix → false', () => {
    expect(isPrefixAtBoundary('claude-opus-4', 'gpt-4')).toBe(false);
  });

  it('longer is the same length as prefix (identical strings) → false', () => {
    expect(isPrefixAtBoundary('gpt-4', 'gpt-4')).toBe(false);
  });

  it('longer is shorter than prefix → false', () => {
    expect(isPrefixAtBoundary('gpt', 'gpt-4')).toBe(false);
  });

  it('an empty prefix → false', () => {
    expect(isPrefixAtBoundary('gpt-4', '')).toBe(false);
  });
});
