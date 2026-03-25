import { describe, it, expect } from 'vitest';
import { parseReviewResponse } from '../../src/core/score-parser.js';

describe('parseReviewResponse', () => {
  it('should parse valid JSON review response', () => {
    const raw = JSON.stringify({
      reviews: [
        {
          label: 'A',
          scores: { accuracy: 8, completeness: 7, practicality: 9, insight: 6, overall: 8 },
          strengths: 'Good analysis',
          weaknesses: 'Missing edge cases',
          ranking: 1,
        },
        {
          label: 'B',
          scores: { accuracy: 6, completeness: 8, practicality: 7, insight: 7, overall: 7 },
          strengths: 'Thorough',
          weaknesses: 'Verbose',
          ranking: 2,
        },
      ],
    });

    const result = parseReviewResponse(raw, ['A', 'B']);
    expect(result.parseMethod).toBe('json');
    expect(result.reviews).toHaveLength(2);
    expect(result.reviews[0]!.scores.accuracy).toBe(8);
    expect(result.reviews[1]!.scores.overall).toBe(7);
  });

  it('should parse JSON embedded in text', () => {
    const raw = `Here's my review:

    {"reviews": [{"label": "A", "scores": {"accuracy": 9, "completeness": 8, "practicality": 7, "insight": 8, "overall": 8}, "strengths": "Great", "weaknesses": "Minor", "ranking": 1}]}

    That's my assessment.`;

    const result = parseReviewResponse(raw, ['A']);
    expect(result.parseMethod).toBe('json');
    expect(result.reviews[0]!.scores.overall).toBe(8);
  });

  it('should clamp scores to 1-10 range', () => {
    const raw = JSON.stringify({
      reviews: [{
        label: 'A',
        scores: { accuracy: 15, completeness: -3, practicality: 5, insight: 5, overall: 5 },
        strengths: '',
        weaknesses: '',
        ranking: 1,
      }],
    });

    const result = parseReviewResponse(raw, ['A']);
    expect(result.reviews[0]!.scores.accuracy).toBe(10);
    expect(result.reviews[0]!.scores.completeness).toBe(1);
  });

  it('should fall back to default scores on parse failure', () => {
    const result = parseReviewResponse('This is just plain text', ['A', 'B']);
    expect(result.parseMethod).toBe('failed');
    expect(result.reviews).toHaveLength(2);
    expect(result.reviews[0]!.status).toBe('parse_error');
    expect(result.reviews[0]!.scores.overall).toBe(5);
  });

  it('should fill missing labels with partial status', () => {
    const raw = JSON.stringify({
      reviews: [{
        label: 'A',
        scores: { accuracy: 8, completeness: 7, practicality: 9, insight: 6, overall: 8 },
        strengths: 'Good',
        weaknesses: 'Minor',
        ranking: 1,
      }],
    });

    const result = parseReviewResponse(raw, ['A', 'B']);
    expect(result.reviews).toHaveLength(2);
    const reviewB = result.reviews.find(r => r.label === 'B');
    expect(reviewB!.status).toBe('partial');
  });
});
