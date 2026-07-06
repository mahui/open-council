/**
 * Tests for the model-family tier rules in src/shared/model-catalog.ts
 * (design-notes/model-config-flow.md §3.1). MODEL_TIER_RULES is the single data
 * source for BOTH flagshipRank (chairman tie-break strength) and
 * isRecommendedModel (default debate participant), replacing the two previously-
 * duplicated hardcoded family regexes in model-assembly.ts and first-run.ts.
 *
 * Pure functions — no mocking, no I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  MODEL_TIER_RULES,
  flagshipRank,
  isRecommendedModel,
} from '../../src/shared/model-catalog.js';

describe('flagshipRank — family-level flagship strength', () => {
  it('ranks the known flagship families by strength', () => {
    expect(flagshipRank('claude-opus-4-6')).toBe(9);
    expect(flagshipRank('gpt-5.4')).toBe(8);
    expect(flagshipRank('o3')).toBe(7);
    expect(flagshipRank('claude-sonnet-4-6')).toBe(5);
    expect(flagshipRank('claude-3-5-sonnet')).toBe(5);
    expect(flagshipRank('o4')).toBe(5);
    expect(flagshipRank('gpt-4o')).toBe(4);
  });

  it('returns 0 for an id in no known flagship family', () => {
    expect(flagshipRank('mystery-model-v2')).toBe(0);
    expect(flagshipRank('llama3.2')).toBe(0);
  });

  it('is family-level, not exact-id: a future id in a known family still ranks', () => {
    // A vendor could ship claude-opus-4-7 before the static catalog is updated.
    expect(flagshipRank('claude-opus-4-7-20260101')).toBe(9);
    expect(flagshipRank('gpt-5.6-turbo')).toBe(8);
  });

  it('matches case-insensitively (id lowercased before matching)', () => {
    expect(flagshipRank('CLAUDE-OPUS-4-6')).toBe(9);
    expect(flagshipRank('GPT-4O')).toBe(4);
  });

  // Deliberate correction #1: gpt-5-mini/nano must NOT inherit the gpt-5 flagship
  // bonus (the old /gpt-5/ regex wrongly gave mini +8). The negative lookahead
  // excludes them, so they fall through to rank 0.
  it('gpt-5-mini and gpt-5-nano do NOT receive the gpt-5 flagship bonus', () => {
    expect(flagshipRank('gpt-5-mini')).toBe(0);
    expect(flagshipRank('gpt-5.4-mini')).toBe(0);
    expect(flagshipRank('gpt-5-nano')).toBe(0);
    expect(flagshipRank('gpt-5.4-nano')).toBe(0);
  });

  // Deliberate correction #3: o4 is a first-class flagship (old flagshipBonus
  // omitted it entirely).
  it('o4 is ranked as a flagship (previously missing from the bonus table)', () => {
    expect(flagshipRank('o4')).toBe(5);
  });
});

describe('isRecommendedModel — default debate participant', () => {
  it('recommends the flagship / balanced families', () => {
    expect(isRecommendedModel('claude-opus-4-6')).toBe(true);
    expect(isRecommendedModel('gpt-5.4')).toBe(true);
    expect(isRecommendedModel('o3')).toBe(true);
    expect(isRecommendedModel('claude-sonnet-4-6')).toBe(true);
    expect(isRecommendedModel('gpt-4o')).toBe(true);
  });

  // Deliberate correction #3: o4 joins the recommended default set.
  it('recommends o4', () => {
    expect(isRecommendedModel('o4')).toBe(true);
  });

  // Deliberate correction #2: nano is economy-tier and must be excluded from the
  // recommended defaults (the old isRecommended only excluded mini).
  it('excludes gpt-5 mini AND nano from the recommended defaults', () => {
    expect(isRecommendedModel('gpt-5-mini')).toBe(false);
    expect(isRecommendedModel('gpt-5-nano')).toBe(false);
    expect(isRecommendedModel('gpt-5.4-nano')).toBe(false);
  });

  it('does not recommend unknown / lightweight ids', () => {
    expect(isRecommendedModel('mystery-model')).toBe(false);
    expect(isRecommendedModel('claude-haiku-4-5')).toBe(false);
    expect(isRecommendedModel('llama3.2')).toBe(false);
  });
});

describe('MODEL_TIER_RULES — single source of truth', () => {
  it('flagshipRank and isRecommendedModel both derive from the same table (mutation is observed by both)', () => {
    // Flip one rule's fields and assert BOTH consumers track the change — proof
    // they read the one table rather than each duplicating the family logic.
    // The rule objects are plain (non-frozen) literals; readonly is compile-time
    // only, so a narrow structural cast (NOT `as any`) lets the test mutate them.
    const opusRule = MODEL_TIER_RULES.find((r) => r.pattern.test('claude-opus-4-6'));
    expect(opusRule).toBeDefined();
    const mutable = opusRule as { rank: number; recommended: boolean };
    const savedRank = mutable.rank;
    const savedRecommended = mutable.recommended;
    try {
      mutable.rank = 1;
      mutable.recommended = false;
      expect(flagshipRank('claude-opus-4-6')).toBe(1);
      expect(isRecommendedModel('claude-opus-4-6')).toBe(false);
    } finally {
      mutable.rank = savedRank;
      mutable.recommended = savedRecommended;
    }
    // Restored: sanity-check no leakage into later tests.
    expect(flagshipRank('claude-opus-4-6')).toBe(9);
    expect(isRecommendedModel('claude-opus-4-6')).toBe(true);
  });

  it('first matching rule wins (ordered evaluation)', () => {
    // opus precedes every other rule; nothing later can override its rank.
    expect(flagshipRank('claude-opus-4-6')).toBe(MODEL_TIER_RULES[0]!.rank);
  });
});
