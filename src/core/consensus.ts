/**
 * Consensus calculation: Kendall's W + model_diversity_factor.
 * Pure logic — no I/O dependencies (ARCH-01).
 */

import type { ConsensusResult, Agent } from '../types/session.js';
import type { ParsedReview } from './score-parser.js';
import type { ModelConfig } from '../types/config.js';

export function calculateConsensus(
  reviews: ParsedReview[],
  agents: Agent[],
): ConsensusResult {
  // 1. Filter valid reviews (exclude PARSE_ERROR)
  const valid = reviews.filter(r => r.status === 'valid' || r.status === 'partial');
  const N = valid.length;
  if (N < 2) {
    return { consensus_score: 0, dimension_scores: {}, model_diversity_factor: 0, raw_agreement: 0 };
  }

  // 2. z-score normalize (eliminate reviewer scale differences)
  const normalized = zScoreNormalize(valid);

  // 3. Compute score standard deviations per answer
  const answerScores = groupScoresByAnswer(normalized);
  const sigmas = Object.values(answerScores).map(scores => standardDeviation(scores));
  const sigmaAvg = mean(sigmas);

  // 4. Kendall's W rank concordance
  const W = kendallsW(normalized);

  // 5. Small sample correction
  const rho = (N - 1) / N;

  // 6. Model Diversity Factor (delta)
  const uniqueProviders = new Set(agents.map(a => getProviderFamily(a.config)));
  const D = uniqueProviders.size;
  const A = agents.length;
  let delta = D / A;
  if (D < 2) delta *= 0.7; // Single-supplier hard reduction

  // 7. Combined consensus score
  const rawAgreement = 0.5 * (1 - sigmaAvg / 4.5) + 0.5 * W;
  const score = Math.max(0, Math.min(1, rawAgreement * rho * delta));

  // 8. Per-dimension divergence analysis
  const dimensions = ['accuracy', 'completeness', 'practicality', 'insight'] as const;
  const dimensionScores: Record<string, { score: number; divergence: number }> = {};
  for (const dim of dimensions) {
    const dimScores = groupScoresByDimension(normalized, dim);
    const dimSigma = mean(Object.values(dimScores).map(standardDeviation));
    dimensionScores[dim] = {
      score: 1 - dimSigma / 4.5,
      divergence: dimSigma,
    };
  }

  return {
    consensus_score: score,
    dimension_scores: dimensionScores,
    model_diversity_factor: delta,
    raw_agreement: rawAgreement * rho,
  };
}

export function getProviderFamily(config: ModelConfig): string {
  if (config.provider) return config.provider;
  const binary = config.binary ?? '';
  if (binary.includes('claude')) return 'anthropic';
  if (binary.includes('codex')) return 'openai';
  if (binary.includes('gemini')) return 'google';
  if (binary.includes('ollama')) return 'ollama';
  return binary;
}

// --- Statistical helpers ---

function zScoreNormalize(reviews: ParsedReview[]): ParsedReview[] {
  // Compute z-scores per reviewer (across all their given scores)
  return reviews.map(review => {
    const scores = Object.values(review.scores);
    const m = mean(scores);
    const sd = standardDeviation(scores);
    if (sd === 0) return review;

    const normalizedScores: Record<string, number> = {};
    for (const [key, val] of Object.entries(review.scores)) {
      normalizedScores[key] = (val - m) / sd;
    }

    return {
      ...review,
      scores: normalizedScores as unknown as ParsedReview['scores'],
    };
  });
}

function groupScoresByAnswer(reviews: ParsedReview[]): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const review of reviews) {
    const label = review.label;
    if (!result[label]) result[label] = [];
    result[label].push(review.scores.overall);
  }
  return result;
}

function groupScoresByDimension(
  reviews: ParsedReview[],
  dimension: string,
): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const review of reviews) {
    const label = review.label;
    if (!result[label]) result[label] = [];
    const scoreRecord = review.scores as unknown as Record<string, number>;
    const score = scoreRecord[dimension] ?? 0;
    result[label].push(score);
  }
  return result;
}

function kendallsW(reviews: ParsedReview[]): number {
  // Extract ranking info from overall scores
  const labels = [...new Set(reviews.map(r => r.label))];
  const k = reviews.length; // number of raters
  const n = labels.length;  // number of items being ranked

  if (k < 2 || n < 2) return 0;

  // Create rank matrix: each reviewer ranks the items
  const rankings: number[][] = [];
  for (const review of reviews) {
    // Use overall score as ranking basis (higher score = better rank)
    const rank = labels.indexOf(review.label) + 1;
    rankings.push([rank]);
  }

  // Compute sum of ranks per item
  const rankSums = new Array<number>(n).fill(0);
  for (const review of reviews) {
    const itemIndex = labels.indexOf(review.label);
    if (itemIndex >= 0 && rankSums[itemIndex] !== undefined) {
      rankSums[itemIndex] += review.scores.overall;
    }
  }

  // Kendall's W = 12 * S / (k^2 * (n^3 - n))
  const meanRankSum = mean(rankSums);
  const S = rankSums.reduce((sum, r) => sum + (r - meanRankSum) ** 2, 0);
  const W = (12 * S) / (k * k * (n * n * n - n));

  return Math.max(0, Math.min(1, W));
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function standardDeviation(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}
