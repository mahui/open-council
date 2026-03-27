/**
 * Review JSON score parsing with fallback strategies.
 * Pure logic — no I/O dependencies (ARCH-01).
 */

export interface ReviewScore {
  accuracy: number;
  completeness: number;
  practicality: number;
  insight: number;
  overall: number;
}

export interface ParsedReview {
  label: string;
  scores: ReviewScore;
  strengths: string;
  weaknesses: string;
  ranking: number;
  status: 'valid' | 'partial' | 'parse_error';
  /** The agent_id of the reviewer. Set by the orchestrator after parsing. */
  reviewer_agent_id?: string;
}

export interface ReviewParseResult {
  reviews: ParsedReview[];
  parseMethod: 'json' | 'regex' | 'failed';
}

export function parseReviewResponse(raw: string, expectedLabels: string[]): ReviewParseResult {
  // Strategy 1: Try JSON parsing
  const jsonResult = tryJsonParse(raw, expectedLabels);
  if (jsonResult) return { reviews: jsonResult, parseMethod: 'json' };

  // Strategy 2: Try regex extraction
  const regexResult = tryRegexParse(raw, expectedLabels);
  if (regexResult) return { reviews: regexResult, parseMethod: 'regex' };

  // Strategy 3: Return empty with parse_error status
  return {
    reviews: expectedLabels.map(label => ({
      label,
      scores: { accuracy: 5, completeness: 5, practicality: 5, insight: 5, overall: 5 },
      strengths: '',
      weaknesses: '',
      ranking: 0,
      status: 'parse_error' as const,
    })),
    parseMethod: 'failed',
  };
}

function tryJsonParse(raw: string, expectedLabels: string[]): ParsedReview[] | null {
  try {
    // Extract JSON block from response (may have text before/after)
    const jsonMatch = raw.match(/\{[\s\S]*"reviews"[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as { reviews: unknown[] };
    if (!Array.isArray(parsed.reviews)) return null;

    const reviews: ParsedReview[] = [];
    for (const item of parsed.reviews) {
      const r = item as Record<string, unknown>;
      const scores = r['scores'] as Record<string, unknown> | undefined;
      if (!scores) continue;

      reviews.push({
        label: String(r['label'] ?? ''),
        scores: {
          accuracy: clampScore(Number(scores['accuracy'] ?? 5)),
          completeness: clampScore(Number(scores['completeness'] ?? 5)),
          practicality: clampScore(Number(scores['practicality'] ?? 5)),
          insight: clampScore(Number(scores['insight'] ?? 5)),
          overall: clampScore(Number(scores['overall'] ?? 5)),
        },
        strengths: String(r['strengths'] ?? ''),
        weaknesses: String(r['weaknesses'] ?? ''),
        ranking: Number(r['ranking'] ?? 0),
        status: 'valid',
      });
    }

    // Ensure all expected labels are present
    for (const label of expectedLabels) {
      if (!reviews.find(r => r.label === label)) {
        reviews.push({
          label,
          scores: { accuracy: 5, completeness: 5, practicality: 5, insight: 5, overall: 5 },
          strengths: '',
          weaknesses: '',
          ranking: 0,
          status: 'partial',
        });
      }
    }

    return reviews.length > 0 ? reviews : null;
  } catch {
    return null;
  }
}

function tryRegexParse(raw: string, expectedLabels: string[]): ParsedReview[] | null {
  const reviews: ParsedReview[] = [];

  for (const label of expectedLabels) {
    // Try to find scores for each label
    const sectionRegex = new RegExp(
      `(?:Response\\s+)?${label}[\\s\\S]*?(?:overall|Overall)[:\\s]*(\\d+(?:\\.\\d+)?)`,
      'i',
    );
    const match = raw.match(sectionRegex);
    if (!match) continue;

    const overallScore = clampScore(Number(match[1]));

    // Try to extract individual dimension scores
    const scorePatterns: Record<string, RegExp> = {
      accuracy: new RegExp(`${label}[\\s\\S]*?accuracy[:\\s]*(\\d+(?:\\.\\d+)?)`, 'i'),
      completeness: new RegExp(`${label}[\\s\\S]*?completeness[:\\s]*(\\d+(?:\\.\\d+)?)`, 'i'),
      practicality: new RegExp(`${label}[\\s\\S]*?practicality[:\\s]*(\\d+(?:\\.\\d+)?)`, 'i'),
      insight: new RegExp(`${label}[\\s\\S]*?insight[:\\s]*(\\d+(?:\\.\\d+)?)`, 'i'),
    };

    const scores: ReviewScore = {
      accuracy: overallScore,
      completeness: overallScore,
      practicality: overallScore,
      insight: overallScore,
      overall: overallScore,
    };

    for (const [dim, pattern] of Object.entries(scorePatterns)) {
      const dimMatch = raw.match(pattern);
      if (dimMatch?.[1]) {
        (scores as unknown as Record<string, number>)[dim] = clampScore(Number(dimMatch[1]));
      }
    }

    reviews.push({
      label,
      scores,
      strengths: '',
      weaknesses: '',
      ranking: 0,
      status: 'partial',
    });
  }

  return reviews.length > 0 ? reviews : null;
}

function clampScore(score: number): number {
  if (isNaN(score)) return 5;
  return Math.max(1, Math.min(10, score));
}
