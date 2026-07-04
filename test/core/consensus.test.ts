import { describe, it, expect } from 'vitest';
import { calculateConsensus, mean, standardDeviation, getProviderFamily } from '../../src/core/consensus.js';
import type { ParsedReview } from '../../src/core/score-parser.js';
import type { Agent } from '../../src/types/session.js';
import type { ModelConfig } from '../../src/types/config.js';

function makeReview(label: string, overall: number, status: 'valid' | 'partial' = 'valid'): ParsedReview {
  return {
    label,
    scores: { accuracy: overall, completeness: overall, practicality: overall, insight: overall, overall },
    strengths: '',
    weaknesses: '',
    ranking: 0,
    status,
  };
}

function makeAgent(name: string, provider: string): Agent {
  return {
    agent_id: name,
    config: {
      name,
      provider: provider as ModelConfig['provider'],
      invocation: 'api',
      timeout_seconds: 120,
      capabilities: ['general'],
      priority: 100,
      max_concurrent: 1,
      resource_weight: 1,
      enabled: true,
      streaming: true,
    },
    role: 'analyst',
    role_description: '',
    system_prompt: '',
    is_chairman: false,
    is_devil_advocate: false,
  };
}

describe('calculateConsensus', () => {
  it('should return 0 for less than 2 valid reviews', () => {
    const result = calculateConsensus([makeReview('A', 8)], [makeAgent('a', 'anthropic')]);
    expect(result.consensus_score).toBe(0);
  });

  it('should calculate consensus for agreeing reviews', () => {
    const reviews = [
      makeReview('A', 8),
      makeReview('A', 8),
      makeReview('B', 7),
      makeReview('B', 7),
    ];
    const agents = [
      makeAgent('claude', 'anthropic'),
      makeAgent('gemini', 'google'),
    ];

    const result = calculateConsensus(reviews, agents);
    expect(result.consensus_score).toBeGreaterThanOrEqual(0);
    expect(result.consensus_score).toBeLessThanOrEqual(1);
    expect(result.model_diversity_factor).toBeGreaterThan(0);
  });

  it('should penalize single-provider setups', () => {
    const reviews = [
      makeReview('A', 8),
      makeReview('B', 7),
    ];
    const sameProviderAgents = [
      makeAgent('claude-a', 'anthropic'),
      makeAgent('claude-b', 'anthropic'),
    ];
    const diverseAgents = [
      makeAgent('claude', 'anthropic'),
      makeAgent('gemini', 'google'),
    ];

    const sameResult = calculateConsensus(reviews, sameProviderAgents);
    const diverseResult = calculateConsensus(reviews, diverseAgents);

    expect(sameResult.model_diversity_factor).toBeLessThan(diverseResult.model_diversity_factor);
  });

  it('should include dimension scores', () => {
    const reviews = [
      makeReview('A', 8),
      makeReview('B', 6),
    ];
    const agents = [
      makeAgent('claude', 'anthropic'),
      makeAgent('gemini', 'google'),
    ];

    const result = calculateConsensus(reviews, agents);
    expect(result.dimension_scores).toHaveProperty('accuracy');
    expect(result.dimension_scores).toHaveProperty('completeness');
    expect(result.dimension_scores).toHaveProperty('practicality');
    expect(result.dimension_scores).toHaveProperty('insight');
  });

  it('should filter out parse_error reviews', () => {
    const reviews = [
      makeReview('A', 8),
      { ...makeReview('B', 5), status: 'parse_error' as const },
    ];
    const agents = [makeAgent('claude', 'anthropic')];

    const result = calculateConsensus(reviews, agents);
    expect(result.consensus_score).toBe(0); // Only 1 valid review
  });

  it('should not count filler (parse_error) reviews toward consensus', () => {
    // Three reviewers score answers A and B; a filler answer C (parse_error)
    // must be ignored entirely. Three raters → no small-sample rho penalty.
    const reviews: ParsedReview[] = [];
    for (const reviewer of ['r1', 'r2', 'r3']) {
      reviews.push({ ...makeReview('A', 9), reviewer_agent_id: reviewer });
      reviews.push({ ...makeReview('B', 6), reviewer_agent_id: reviewer });
      reviews.push({ ...makeReview('C', 5, 'valid'), status: 'parse_error', reviewer_agent_id: reviewer });
    }
    const agents = [
      makeAgent('claude', 'anthropic'),
      makeAgent('gemini', 'google'),
      makeAgent('gpt', 'openai'),
    ];

    const result = calculateConsensus(reviews, agents);
    // C's filler must not appear as a ranked answer; the reviewers agree
    // perfectly on A vs B → high agreement.
    expect(result.agreement_score).toBeGreaterThanOrEqual(0.6);
  });

  it('should expose agreement_score = raw_agreement and consensus_score = agreement × delta', () => {
    const reviews = [
      makeReview('A', 9),
      makeReview('A', 9),
      makeReview('B', 6),
      makeReview('B', 6),
    ];
    const agents = [makeAgent('claude', 'anthropic'), makeAgent('gemini', 'google')];

    const result = calculateConsensus(reviews, agents);
    expect(result.agreement_score).toBe(result.raw_agreement);
    expect(result.consensus_score).toBeCloseTo(
      result.agreement_score * result.model_diversity_factor,
      10,
    );
  });

  it('single-provider high-agreement panel reaches the 0.6 stop on agreement_score while consensus_score is delta-discounted', () => {
    // 3 same-provider agents, 3 reviewers, strong concordance on the ranking.
    const reviews: ParsedReview[] = [];
    for (const reviewer of ['r1', 'r2', 'r3']) {
      reviews.push({ ...makeReview('A', 9), reviewer_agent_id: reviewer });
      reviews.push({ ...makeReview('B', 6), reviewer_agent_id: reviewer });
      reviews.push({ ...makeReview('C', 3), reviewer_agent_id: reviewer });
    }
    const agents = [
      makeAgent('claude-a', 'anthropic'),
      makeAgent('claude-b', 'anthropic'),
      makeAgent('claude-c', 'anthropic'),
    ];

    const result = calculateConsensus(reviews, agents);
    // Stop criterion crosses the threshold despite a single provider …
    expect(result.agreement_score).toBeGreaterThanOrEqual(0.6);
    // … but the displayed consensus_score is folded down by delta (D=1 → ×0.7).
    expect(result.model_diversity_factor).toBeCloseTo((1 / 3) * 0.7, 10);
    expect(result.consensus_score).toBeLessThan(result.agreement_score);
    expect(result.consensus_score).toBeLessThan(0.6);
  });

  it('groups answers by reviewed_agent_id when present (label collisions across reviewers)', () => {
    // Per-reviewer anonymization: label "A" means a DIFFERENT answer to each
    // reviewer. Grouping by reviewed_agent_id must keep answers separate;
    // grouping by label would wrongly merge them.
    const reviews: ParsedReview[] = [];
    for (const reviewer of ['r1', 'r2', 'r3']) {
      reviews.push({ ...makeReview('A', 9), reviewer_agent_id: reviewer, reviewed_agent_id: 'ans-x' });
      reviews.push({ ...makeReview('B', 3), reviewer_agent_id: reviewer, reviewed_agent_id: 'ans-y' });
    }
    const agents = [
      makeAgent('claude', 'anthropic'),
      makeAgent('gemini', 'google'),
      makeAgent('gpt', 'openai'),
    ];

    const byId = calculateConsensus(reviews, agents);
    // All reviewers agree ans-x ≫ ans-y → high agreement.
    expect(byId.agreement_score).toBeGreaterThanOrEqual(0.6);
  });

  it('falls back to label grouping when reviewed_agent_id is absent (legacy path)', () => {
    const reviews: ParsedReview[] = [];
    for (const reviewer of ['r1', 'r2', 'r3']) {
      reviews.push({ ...makeReview('A', 9), reviewer_agent_id: reviewer });
      reviews.push({ ...makeReview('B', 3), reviewer_agent_id: reviewer });
    }
    const agents = [
      makeAgent('claude', 'anthropic'),
      makeAgent('gemini', 'google'),
      makeAgent('gpt', 'openai'),
    ];

    const result = calculateConsensus(reviews, agents);
    expect(result.agreement_score).toBeGreaterThanOrEqual(0.6);
  });

  it('imputes the mean rank for the item each rater is missing (self-review exclusion)', () => {
    // 3 answers x/y/z; under self-review exclusion each rater is missing exactly
    // its OWN answer. All raters that DO see a pair agree on the global ordering
    // x > y > z. Kendall's W must stay finite in [0,1] and — because the missing
    // item is imputed at the mean rank rather than ranked last — must be lower
    // than the fully-observed case (conservative, never inflates concordance).
    const agents = [
      makeAgent('ans-x', 'anthropic'),
      makeAgent('ans-y', 'google'),
      makeAgent('ans-z', 'openai'),
    ];

    // Self-exclusion: rater = author; each reviews the other two.
    const excluded: ParsedReview[] = [
      { ...makeReview('L1', 8), reviewer_agent_id: 'ans-x', reviewed_agent_id: 'ans-y' },
      { ...makeReview('L2', 5), reviewer_agent_id: 'ans-x', reviewed_agent_id: 'ans-z' },
      { ...makeReview('L1', 9), reviewer_agent_id: 'ans-y', reviewed_agent_id: 'ans-x' },
      { ...makeReview('L2', 5), reviewer_agent_id: 'ans-y', reviewed_agent_id: 'ans-z' },
      { ...makeReview('L1', 9), reviewer_agent_id: 'ans-z', reviewed_agent_id: 'ans-x' },
      { ...makeReview('L2', 8), reviewer_agent_id: 'ans-z', reviewed_agent_id: 'ans-y' },
    ];

    // Fully-observed counterpart: every rater ranks all three answers.
    const full: ParsedReview[] = [];
    for (const reviewer of ['ans-x', 'ans-y', 'ans-z']) {
      full.push({ ...makeReview('L1', 9), reviewer_agent_id: reviewer, reviewed_agent_id: 'ans-x' });
      full.push({ ...makeReview('L2', 8), reviewer_agent_id: reviewer, reviewed_agent_id: 'ans-y' });
      full.push({ ...makeReview('L3', 5), reviewer_agent_id: reviewer, reviewed_agent_id: 'ans-z' });
    }

    const excludedResult = calculateConsensus(excluded, agents);
    const fullResult = calculateConsensus(full, agents);

    // Finite, in-range, and still detects the concordance (positive).
    expect(Number.isFinite(excludedResult.agreement_score)).toBe(true);
    expect(excludedResult.agreement_score).toBeGreaterThan(0);
    expect(excludedResult.agreement_score).toBeLessThanOrEqual(1);
    // Conservative: imputation never rates concordance above complete data.
    expect(excludedResult.agreement_score).toBeLessThan(fullResult.agreement_score);
  });
});

describe('mean', () => {
  it('should compute arithmetic mean', () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
    expect(mean([10])).toBe(10);
    expect(mean([])).toBe(0);
  });
});

describe('standardDeviation', () => {
  it('should compute sample standard deviation', () => {
    expect(standardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 2);
    expect(standardDeviation([5])).toBe(0);
    expect(standardDeviation([])).toBe(0);
  });
});

describe('getProviderFamily', () => {
  it('should return provider when set', () => {
    expect(getProviderFamily({ provider: 'anthropic' } as ModelConfig)).toBe('anthropic');
  });

  it('should infer from binary name', () => {
    expect(getProviderFamily({ binary: 'claude' } as ModelConfig)).toBe('anthropic');
    expect(getProviderFamily({ binary: 'codex' } as ModelConfig)).toBe('openai');
    expect(getProviderFamily({ binary: 'gemini' } as ModelConfig)).toBe('google');
    expect(getProviderFamily({ binary: 'ollama-server' } as ModelConfig)).toBe('ollama');
  });

  it('should fall back to the raw binary string when it matches no known family', () => {
    expect(getProviderFamily({ binary: 'some-custom-cli' } as ModelConfig)).toBe('some-custom-cli');
  });

  it('should fall back to an empty string when neither provider nor binary is set', () => {
    expect(getProviderFamily({} as ModelConfig)).toBe('');
  });
});
