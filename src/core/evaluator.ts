/**
 * Benchmark evaluation logic — coverage scoring and error rate detection.
 * Pure logic layer; no I/O (ARCH-01).
 */

import type { InvocationAdapter } from '../types/provider.js';
import type { ModelConfig } from '../types/config.js';

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export interface CoverageResult {
  point: string;
  covered: 'yes' | 'partial' | 'no';
}

export interface ErrorResult {
  trap: string;
  triggered: boolean;
}

export interface CoverageEvaluation {
  score: number;
  details: CoverageResult[];
}

export interface ErrorEvaluation {
  /** Fraction of traps that fired (0.0 – 1.0). */
  errorRate: number;
  /** Complement: 1.0 − errorRate. Stored in BenchmarkResult.error_score. */
  errorScore: number;
  details: ErrorResult[];
}

// ---------------------------------------------------------------------------
// Prompt builders (pure, no I/O)
// ---------------------------------------------------------------------------

function buildCoveragePrompt(
  question: string,
  response: string,
  expectedPoints: string[],
): string {
  const pointsList = expectedPoints
    .map((p, i) => `${i + 1}. ${p}`)
    .join('\n');

  return [
    'Evaluating coverage of response against expected key points.',
    '',
    `Question: ${question}`,
    '',
    'Response:',
    response,
    '',
    'For each expected point below, determine if it is COVERED in the response.',
    '- YES: clearly and substantively addressed',
    '- PARTIAL: mentioned but incomplete or unclear',
    '- NO: not mentioned or incorrect',
    '',
    'Points:',
    pointsList,
    '',
    'Return ONLY JSON (no markdown fences, no commentary):',
    '[{"point": "...", "covered": "yes"|"partial"|"no"}]',
  ].join('\n');
}

function buildErrorPrompt(
  question: string,
  response: string,
  traps: Array<{ type: string; description: string }>,
): string {
  const trapsList = traps
    .map((t, i) => `${i + 1}. [${t.type}] ${t.description}`)
    .join('\n');

  return [
    'Check if any of these known error patterns appear in the response.',
    '',
    `Question: ${question}`,
    '',
    'Response:',
    response,
    '',
    'Known error patterns (check if present in the response):',
    trapsList,
    '',
    'Return ONLY JSON (no markdown fences, no commentary):',
    '[{"trap": "...", "triggered": true|false}]',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// JSON extraction helpers
// ---------------------------------------------------------------------------

function extractJson(raw: string): string {
  // Strip optional markdown code fences and surrounding whitespace.
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  return fenceMatch ? fenceMatch[1]!.trim() : raw.trim();
}

function parseCoverageJson(raw: string, expectedCount: number): CoverageResult[] {
  const cleaned = extractJson(raw);
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new TypeError('Coverage response is not an array');

  return (parsed as Array<Record<string, unknown>>).slice(0, expectedCount).map((item) => {
    const covered = String(item['covered'] ?? 'no').toLowerCase();
    if (covered !== 'yes' && covered !== 'partial' && covered !== 'no') {
      throw new TypeError(`Invalid covered value: ${covered}`);
    }
    return {
      point: String(item['point'] ?? ''),
      covered,
    };
  });
}

function parseErrorJson(raw: string, trapCount: number): ErrorResult[] {
  const cleaned = extractJson(raw);
  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw new TypeError('Error response is not an array');

  return (parsed as Array<Record<string, unknown>>).slice(0, trapCount).map((item) => ({
    trap: String(item['trap'] ?? ''),
    triggered: Boolean(item['triggered']),
  }));
}

// ---------------------------------------------------------------------------
// Public evaluation functions
// ---------------------------------------------------------------------------

/**
 * Ask the judge model whether each expected point is covered in the response.
 * On parse failure, returns score=0 and empty details (graceful degradation).
 */
export async function evaluateCoverage(
  question: string,
  response: string,
  expectedPoints: string[],
  adapter: InvocationAdapter,
  judgeModel: ModelConfig,
): Promise<CoverageEvaluation> {
  if (expectedPoints.length === 0) {
    return { score: 0, details: [] };
  }

  const prompt = buildCoveragePrompt(question, response, expectedPoints);

  let raw: string;
  try {
    const result = await adapter.invoke(judgeModel, prompt);
    raw = result.response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[evaluator] coverage invoke failed: ${msg}\n`);
    return { score: 0, details: [] };
  }

  let details: CoverageResult[];
  try {
    details = parseCoverageJson(raw, expectedPoints.length);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[evaluator] coverage parse failed: ${msg}\n`);
    return { score: 0, details: [] };
  }

  const total = details.length;
  if (total === 0) return { score: 0, details: [] };

  const sum = details.reduce((acc, d) => {
    if (d.covered === 'yes') return acc + 1.0;
    if (d.covered === 'partial') return acc + 0.5;
    return acc;
  }, 0);

  return { score: sum / total, details };
}

/**
 * Ask the judge model whether each known trap was triggered in the response.
 * On parse failure, returns errorRate=0 and empty details (graceful degradation).
 */
export async function evaluateErrors(
  question: string,
  response: string,
  knownTraps: Array<{ type: string; description: string }>,
  adapter: InvocationAdapter,
  judgeModel: ModelConfig,
): Promise<ErrorEvaluation> {
  if (knownTraps.length === 0) {
    return { errorRate: 0, errorScore: 1.0, details: [] };
  }

  const prompt = buildErrorPrompt(question, response, knownTraps);

  let raw: string;
  try {
    const result = await adapter.invoke(judgeModel, prompt);
    raw = result.response;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[evaluator] error-rate invoke failed: ${msg}\n`);
    return { errorRate: 0, errorScore: 1.0, details: [] };
  }

  let details: ErrorResult[];
  try {
    details = parseErrorJson(raw, knownTraps.length);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[evaluator] error-rate parse failed: ${msg}\n`);
    return { errorRate: 0, errorScore: 1.0, details: [] };
  }

  const total = details.length;
  if (total === 0) return { errorRate: 0, errorScore: 1.0, details: [] };

  const triggered = details.filter(d => d.triggered).length;
  const errorRate = triggered / total;
  return { errorRate, errorScore: 1.0 - errorRate, details };
}
