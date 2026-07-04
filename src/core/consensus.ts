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
  if (valid.length < 2) {
    return { consensus_score: 0, dimension_scores: {}, model_diversity_factor: 0, raw_agreement: 0 };
  }

  // 2. Group reviews by reviewer (agent_id) — each agent is one rater
  const byReviewer = groupByReviewer(valid);
  const reviewerCount = byReviewer.size;

  // 3. z-score normalize per reviewer (eliminate scale differences)
  const normalized = zScoreNormalizeByReviewer(valid, byReviewer);

  // 4. Compute score standard deviations per answer (on ORIGINAL scale for sigma)
  //    Use raw scores for sigma-based agreement (1-10 scale), z-scores for Kendall's W
  const answerScoresRaw = groupScoresByAnswer(valid);
  const sigmas = Object.values(answerScoresRaw).map(scores => standardDeviation(scores));
  const sigmaAvg = mean(sigmas);

  // 5. Kendall's W rank concordance (uses z-scored overall, grouped by reviewer)
  const W = kendallsW(normalized, byReviewer);

  // 6. Small sample correction (based on number of raters, not total reviews)
  const rho = reviewerCount < 3 ? (reviewerCount - 1) / reviewerCount : 1;

  // 7. Model Diversity Factor (delta)
  const uniqueProviders = new Set(agents.map(a => getProviderFamily(a.config)));
  const D = uniqueProviders.size;
  const A = agents.length;
  let delta = D / A;
  if (D < 2) delta *= 0.7; // Single-supplier hard reduction

  // 8. Combined consensus score
  //    sigmaAvg is on 1-10 scale, divide by 4.5 to normalize
  const rawAgreement = 0.5 * (1 - sigmaAvg / 4.5) + 0.5 * W;
  const score = Math.max(0, Math.min(1, rawAgreement * rho * delta));

  // 9. Per-dimension divergence analysis (on raw scores)
  const dimensions = ['accuracy', 'completeness', 'practicality', 'insight'] as const;
  const dimensionScores: Record<string, { score: number; divergence: number }> = {};
  for (const dim of dimensions) {
    const dimScores = groupScoresByDimension(valid, dim);
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

/** Group reviews by their reviewer (agent_id). Each agent is one rater. */
function groupByReviewer(reviews: ParsedReview[]): Map<string, ParsedReview[]> {
  const result = new Map<string, ParsedReview[]>();
  for (const review of reviews) {
    const reviewerId = review.reviewer_agent_id ?? review.label;
    const list = result.get(reviewerId) ?? [];
    list.push(review);
    result.set(reviewerId, list);
  }
  return result;
}

/**
 * z-score normalize per reviewer.
 * Each reviewer's overall scores are normalized to mean=0, std=1 within
 * that reviewer's own scoring distribution. This eliminates scale differences
 * between lenient and strict reviewers.
 */
function zScoreNormalizeByReviewer(
  reviews: ParsedReview[],
  byReviewer: Map<string, ParsedReview[]>,
): ParsedReview[] {
  // Pre-compute per-reviewer stats on the overall score
  const reviewerStats = new Map<string, { mean: number; sd: number }>();
  for (const [reviewerId, revs] of byReviewer) {
    const overalls = revs.map(r => r.scores.overall);
    reviewerStats.set(reviewerId, { mean: mean(overalls), sd: standardDeviation(overalls) });
  }

  return reviews.map(review => {
    const reviewerId = review.reviewer_agent_id ?? review.label;
    const stats = reviewerStats.get(reviewerId);
    if (!stats || stats.sd === 0) return review;

    const normalizedScores: Record<string, number> = {};
    for (const [key, val] of Object.entries(review.scores)) {
      normalizedScores[key] = (val - stats.mean) / stats.sd;
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

/**
 * Kendall's W (coefficient of concordance).
 *
 * Computes rank concordance across k raters on n items.
 * Each rater's overall scores are converted to ranks (1 = highest score).
 * W = 12S / (k²(n³ - n)) where S = Σ(Rⱼ - R̄)²
 */
function kendallsW(
  reviews: ParsedReview[],
  byReviewer: Map<string, ParsedReview[]>,
): number {
  const labels = [...new Set(reviews.map(r => r.label))];
  const n = labels.length;   // number of items being ranked
  const k = byReviewer.size; // number of raters (reviewers)

  if (k < 2 || n < 2) return 0;

  // For each rater, convert their overall scores to ranks
  // rank 1 = highest score, ties get average rank
  const rankSums = new Array<number>(n).fill(0);

  for (const [, raterReviews] of byReviewer) {
    // Build score array for this rater's items
    const scoresByLabel = new Map<string, number>();
    for (const review of raterReviews) {
      scoresByLabel.set(review.label, review.scores.overall);
    }

    // Sort by score descending to compute ranks
    const sorted = labels
      .map(label => ({ label, score: scoresByLabel.get(label) ?? 0 }))
      .sort((a, b) => b.score - a.score);

    // Assign ranks with tie averaging
    const ranks = new Map<string, number>();
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j < sorted.length && sorted[j]!.score === sorted[i]!.score) j++;
      const avgRank = (i + 1 + j) / 2; // average rank for tied items
      for (let t = i; t < j; t++) {
        ranks.set(sorted[t]!.label, avgRank);
      }
      i = j;
    }

    // Accumulate rank sums per item
    for (let idx = 0; idx < labels.length; idx++) {
      rankSums[idx] = (rankSums[idx] ?? 0) + (ranks.get(labels[idx]!) ?? 0);
    }
  }

  // W = 12S / (k²(n³ - n))
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
