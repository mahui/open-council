import { describe, it, expect } from 'vitest';
import { resolveMode, classifyQuestion, allocateSeats } from '../../src/core/router.js';
import type { ModelConfig } from '../../src/types/config.js';

function makeModel(name: string, provider: string, caps: string[] = ['general']): ModelConfig {
  return {
    name,
    invocation: 'api',
    provider: provider as ModelConfig['provider'],
    model: `${provider}-model`,
    timeout_seconds: 120,
    capabilities: caps,
    priority: 100,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: true,
  };
}

describe('resolveMode', () => {
  const models = [makeModel('claude', 'anthropic'), makeModel('gemini', 'google')];

  it('should return quick when only 1 model available', () => {
    const decision = resolveMode('test question', [models[0]!]);
    expect(decision.mode).toBe('quick');
  });

  it('should handle comparison questions', () => {
    const decision = resolveMode('Redis vs Memcached', models);
    expect(['compare', 'debate']).toContain(decision.mode);
  });

  it('should return debate for complex architecture questions', () => {
    const decision = resolveMode(
      'Please analyze the architecture design tradeoffs of microservices versus monolith in a distributed system',
      models,
    );
    expect(decision.mode).toBe('debate');
    expect(decision.reason).toBeDefined();
  });

  it('should include question type classification', () => {
    const decision = resolveMode('How to fix this code bug?', models);
    expect(decision.questionType).toBeDefined();
  });
});

describe('classifyQuestion', () => {
  it('should classify code questions', () => {
    expect(classifyQuestion('How to debug this function?')).toBe('code');
  });

  it('should classify architecture questions', () => {
    expect(classifyQuestion('Design a microservice architecture')).toBe('architecture');
  });

  it('should classify comparison questions', () => {
    expect(classifyQuestion('Redis vs Memcached')).toBe('comparison');
  });

  it('should default to general for unrecognized questions', () => {
    expect(classifyQuestion('What is the meaning of life?')).toBe('general');
  });

  // Chinese keyword matching — regression for `\b` never matching CJK characters.
  it('should classify Chinese code questions', () => {
    expect(classifyQuestion('帮我重构这段代码')).toBe('code');
  });

  it('should classify Chinese architecture questions', () => {
    expect(classifyQuestion('这个系统架构设计合理吗')).toBe('architecture');
  });

  it('should classify Chinese comparison questions', () => {
    expect(classifyQuestion('对比一下 React 和 Vue')).toBe('comparison');
  });

  it('should classify Chinese security questions', () => {
    expect(classifyQuestion('这里有 SQL 注入风险吗')).toBe('security');
  });

  it('should classify Chinese math questions', () => {
    expect(classifyQuestion('这个方程怎么求解')).toBe('math');
  });

  it('should classify Chinese creative questions', () => {
    expect(classifyQuestion('给我一些创新的想法')).toBe('creative');
  });

  it('should still keep English word boundaries (no substring match)', () => {
    // `code` must not match inside `decode` / `encoder`
    expect(classifyQuestion('The encoder pipeline runs nightly')).toBe('general');
  });
});

describe('allocateSeats', () => {
  it('should allocate agents for available models', () => {
    const models = [
      makeModel('claude', 'anthropic'),
      makeModel('gemini', 'google'),
    ];

    const result = allocateSeats({
      models,
      options: { mode: 'compare' },
      questionType: 'general',
      resolvedMode: 'compare',
    });

    expect(result.agents.length).toBeGreaterThan(0);
    expect(result.chairmanId).toBeDefined();
  });

  it('should return empty for no models', () => {
    const result = allocateSeats({
      models: [],
      options: { mode: 'compare' },
      questionType: 'general',
      resolvedMode: 'compare',
    });

    expect(result.agents).toHaveLength(0);
  });
});
