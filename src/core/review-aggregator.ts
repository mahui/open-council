/**
 * Review aggregation: fold every reviewer's evaluation of a single answer into
 * one summary, keyed by the reviewed answer's global agent_id.
 * Pure logic — no I/O dependencies (ARCH-01).
 *
 * Consumed by prompt-builder (cross-examine / synthesis) so that:
 * - an author can see the aggregated peer critique of *their own* answer, and
 * - the Chairman can weigh answers by their peer-review reception.
 *
 * Reviewer identity is intentionally dropped here (the critique is presented
 * de-identified/aggregated). Only the reviewed answer's identity — already
 * public in cross-examine/synthesis — is retained via `reviewed_agent_id`.
 */

import type { ParsedReview } from './score-parser.js';

/** Aggregated peer evaluation of one answer. */
export interface AnswerReviewSummary {
  /** Global agent_id of the reviewed answer. */
  reviewed_agent_id: string;
  /** Resolved role name of the reviewed answer's author (non-anonymous here). */
  role: string;
  /** Mean of reviewers' `overall` scores (0 when no scored reviews). */
  avg_overall: number;
  /** Each reviewer's stated strengths (empty entries dropped). */
  strengths: string[];
  /** Each reviewer's stated weaknesses (empty entries dropped). */
  weaknesses: string[];
  /** Devil's Advocate risk notes (empty entries dropped). */
  devil_advocate_notes: string[];
  /** Number of valid reviewing seats that contributed to this summary. */
  reviewer_count: number;
}

/**
 * Aggregate parsed reviews into per-answer summaries.
 *
 * @param reviews       Parsed reviews with `reviewed_agent_id` resolved by the
 *                      orchestrator. Reviews without it, or with `parse_error`
 *                      status, are ignored (no reliable target / no real data).
 * @param agentIdToRole Map from agent_id to resolved role name.
 * @returns Map keyed by `reviewed_agent_id`.
 */
export function buildReviewSummaries(
  reviews: readonly ParsedReview[],
  agentIdToRole: ReadonlyMap<string, string>,
): Map<string, AnswerReviewSummary> {
  const summaries = new Map<string, AnswerReviewSummary>();

  for (const review of reviews) {
    const agentId = review.reviewed_agent_id;
    if (!agentId) continue;
    if (review.status === 'parse_error') continue;

    let summary = summaries.get(agentId);
    if (!summary) {
      summary = {
        reviewed_agent_id: agentId,
        role: agentIdToRole.get(agentId) ?? agentId,
        avg_overall: 0,
        strengths: [],
        weaknesses: [],
        devil_advocate_notes: [],
        reviewer_count: 0,
      };
      summaries.set(agentId, summary);
    }

    summary.reviewer_count += 1;
    summary.avg_overall += review.scores.overall;

    const strength = review.strengths.trim();
    if (strength) summary.strengths.push(strength);

    const weakness = review.weaknesses.trim();
    if (weakness) summary.weaknesses.push(weakness);

    const daNotes = (review.devil_advocate_notes ?? '').trim();
    if (daNotes) summary.devil_advocate_notes.push(daNotes);
  }

  // Convert accumulated overall sums into means.
  for (const summary of summaries.values()) {
    if (summary.reviewer_count > 0) {
      summary.avg_overall = summary.avg_overall / summary.reviewer_count;
    }
  }

  return summaries;
}
