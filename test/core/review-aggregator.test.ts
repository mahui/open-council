import { describe, it, expect } from 'vitest';
import { buildReviewSummaries } from '../../src/core/review-aggregator.js';
import type { ParsedReview } from '../../src/core/score-parser.js';

function review(overrides: Partial<ParsedReview>): ParsedReview {
  return {
    label: 'A',
    scores: { accuracy: 5, completeness: 5, practicality: 5, insight: 5, overall: 5 },
    strengths: '',
    weaknesses: '',
    devil_advocate_notes: '',
    ranking: 0,
    status: 'valid',
    ...overrides,
  };
}

describe('buildReviewSummaries', () => {
  it('aggregates multiple reviewers of the same answer by reviewed_agent_id', () => {
    const reviews: ParsedReview[] = [
      review({
        reviewed_agent_id: 'a1',
        scores: { accuracy: 8, completeness: 8, practicality: 8, insight: 8, overall: 8 },
        strengths: 'Clear structure',
        weaknesses: 'Ignores cost',
      }),
      review({
        reviewed_agent_id: 'a1',
        scores: { accuracy: 6, completeness: 6, practicality: 6, insight: 6, overall: 6 },
        strengths: 'Good evidence',
        weaknesses: 'Overconfident',
      }),
    ];

    const summaries = buildReviewSummaries(reviews, new Map([['a1', 'Analyst']]));
    const s = summaries.get('a1');
    expect(s).toBeDefined();
    expect(s!.role).toBe('Analyst');
    expect(s!.reviewer_count).toBe(2);
    expect(s!.avg_overall).toBe(7); // (8 + 6) / 2
    expect(s!.strengths).toEqual(['Clear structure', 'Good evidence']);
    expect(s!.weaknesses).toEqual(['Ignores cost', 'Overconfident']);
  });

  it('collects devil_advocate_notes and drops empty text', () => {
    const reviews: ParsedReview[] = [
      review({ reviewed_agent_id: 'a1', devil_advocate_notes: 'Assumes stable traffic', weaknesses: '' }),
      review({ reviewed_agent_id: 'a1', devil_advocate_notes: '', weaknesses: '  ' }),
    ];
    const summaries = buildReviewSummaries(reviews, new Map());
    const s = summaries.get('a1')!;
    expect(s.devil_advocate_notes).toEqual(['Assumes stable traffic']);
    expect(s.weaknesses).toEqual([]); // whitespace-only dropped
    expect(s.reviewer_count).toBe(2);
  });

  it('ignores reviews without a reviewed_agent_id', () => {
    const reviews: ParsedReview[] = [
      review({ reviewed_agent_id: undefined, weaknesses: 'orphan' }),
      review({ reviewed_agent_id: 'a2', weaknesses: 'kept' }),
    ];
    const summaries = buildReviewSummaries(reviews, new Map());
    expect(summaries.size).toBe(1);
    expect(summaries.get('a2')!.weaknesses).toEqual(['kept']);
  });

  it('excludes parse_error reviews', () => {
    const reviews: ParsedReview[] = [
      review({ reviewed_agent_id: 'a1', status: 'parse_error', weaknesses: 'noise' }),
    ];
    const summaries = buildReviewSummaries(reviews, new Map());
    expect(summaries.size).toBe(0);
  });

  it('falls back to agent_id when role is unknown', () => {
    const reviews: ParsedReview[] = [review({ reviewed_agent_id: 'unknown-id' })];
    const summaries = buildReviewSummaries(reviews, new Map());
    expect(summaries.get('unknown-id')!.role).toBe('unknown-id');
  });

  it('returns an empty map for no reviews', () => {
    expect(buildReviewSummaries([], new Map()).size).toBe(0);
  });
});
