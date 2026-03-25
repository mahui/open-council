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
  });
});
