import { describe, it, expect } from 'vitest';
import { resolveMode, classifyQuestion, effectiveLength } from '../../src/core/router.js';
import type { ModelConfig, CouncilConfig } from '../../src/types/config.js';

function makeModel(name: string, provider: string, caps: string[] = ['general'], priority = 100): ModelConfig {
  return {
    name,
    invocation: 'api',
    provider: provider as ModelConfig['provider'],
    model: `${provider}-model`,
    timeout_seconds: 120,
    capabilities: caps,
    priority,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: true,
  };
}

/** Minimal but complete `general` config block, with sensible defaults, for resolveMode(). */
function makeGeneralConfig(overrides: Partial<CouncilConfig['general']> = {}): Pick<CouncilConfig, 'general'> {
  return {
    general: {
      default_mode: 'auto',
      default_chairman: '',
      min_agents: 2,
      max_agents: 5,
      allow_same_model_agents: true,
      review_rounds: 1,
      language: 'auto',
      compression_threshold_ratio: 0.6,
      devil_advocate: 'auto',
      high_risk_keywords: [],
      ...overrides,
    },
  };
}

/** Minimal but complete `general` + `routing` config block for resolveMode(). */
function makeRouteConfig(
  generalOverrides: Partial<CouncilConfig['general']> = {},
): Pick<CouncilConfig, 'general' | 'routing'> {
  return {
    ...makeGeneralConfig(generalOverrides),
    routing: {
      strategy: 'keyword',
      dynamic_weight: false,
      dynamic_weight_alpha: 0.5,
      dynamic_weight_shadow: false,
      exploration_rate: 0,
      rules: [],
      default: { prefer: [], chairman: '', role_set: 'default' },
    },
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

  it('routes long general questions to debate when 3+ models are available', () => {
    const three = [...models, makeModel('gpt', 'openai')];
    const longQuestion = 'a'.repeat(130) + ' explain this thoroughly please with full detail';
    const decision = resolveMode(longQuestion, three);
    expect(decision.mode).toBe('debate');
    expect(decision.reason).toContain('Long question');
  });

  it('does not escalate a long question to debate with only 2 models', () => {
    const longQuestion = 'a'.repeat(130) + ' explain this thoroughly please with full detail';
    const decision = resolveMode(longQuestion, models);
    expect(decision.mode).not.toBe('debate');
  });

  it('routes short general questions to compare', () => {
    const decision = resolveMode('Hi there', models);
    expect(decision.mode).toBe('compare');
    expect(decision.reason).toBe('Short general question');
  });

  // CJK weighting (effectiveLength): a compact Chinese architecture question
  // carries enough information density to clear the >50 debate threshold, where
  // its raw char count (< 50) previously never would.
  it('routes an information-dense Chinese architecture question to debate', () => {
    const decision = resolveMode(
      '请详细分析如何设计一个高可用的分布式缓存系统的整体架构与容错方案',
      models,
    );
    expect(decision.questionType).toBe('architecture');
    expect(decision.mode).toBe('debate');
  });

  it('respects the configured max_agents when estimating calls for a debate', () => {
    const three = [...models, makeModel('gpt', 'openai')];
    const decision = resolveMode(
      'Please analyze the architecture design tradeoffs of microservices versus monolith in a distributed system',
      three,
      makeRouteConfig({ max_agents: 2 }),
    );
    expect(decision.mode).toBe('debate');
    expect(decision.estimatedCalls).toBe(2 * 3);
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

  it('classifies as architecture when the question matches a configured high-risk keyword', () => {
    expect(classifyQuestion('Should we deploy to prod-cluster-7 today?', ['prod-cluster-7'])).toBe('architecture');
  });

  it('is case-insensitive when matching high-risk keywords', () => {
    expect(classifyQuestion('Touching the PAYMENT-GATEWAY service', ['payment-gateway'])).toBe('architecture');
  });

  it('falls through to normal keyword rules when no high-risk keyword matches', () => {
    expect(classifyQuestion('How to debug this function?', ['unrelated-keyword'])).toBe('code');
  });
});

describe('effectiveLength', () => {
  it('counts each Latin character as 1 (equivalent to raw length)', () => {
    expect(effectiveLength('hello world')).toBe('hello world'.length);
  });

  it('trims surrounding whitespace before measuring', () => {
    expect(effectiveLength('   hi   ')).toBe(2);
  });

  it('weights each CJK character as 2.5', () => {
    // 2 ideographs × 2.5 = 5
    expect(effectiveLength('架构')).toBe(5);
  });

  it('floors the weighted total to an integer', () => {
    // 1 ideograph × 2.5 = 2.5 → floor 2
    expect(effectiveLength('架')).toBe(2);
  });

  it('mixes CJK and Latin weights', () => {
    // 2 CJK × 2.5 + 3 Latin = 8
    expect(effectiveLength('中文abc')).toBe(8);
  });

  it('makes a Chinese architecture question outweigh its raw char count', () => {
    const q = '如何设计一个高可用的分布式缓存系统架构方案';
    expect(effectiveLength(q)).toBeGreaterThan(q.length);
  });
});

describe('resolveMode — CJK architecture questions clear the lowered gate', () => {
  const models = [
    { name: 'a', invocation: 'api', provider: 'anthropic', timeout_seconds: 120, capabilities: ['general'], priority: 100, max_concurrent: 1, resource_weight: 1, enabled: true, streaming: true },
    { name: 'b', invocation: 'api', provider: 'openai', timeout_seconds: 120, capabilities: ['general'], priority: 90, max_concurrent: 1, resource_weight: 1, enabled: true, streaming: true },
    { name: 'c', invocation: 'api', provider: 'google', timeout_seconds: 120, capabilities: ['general'], priority: 80, max_concurrent: 1, resource_weight: 1, enabled: true, streaming: true },
  ] as never[];

  it('典型 17 字中文架构问题（有效长度 ~43）进入 debate', () => {
    const d = resolveMode('如何设计一个高可用的分布式缓存系统？', models);
    expect(d.mode).toBe('debate');
  });

  it('过短的中文架构句（"架构好吗"）仍不触发 debate', () => {
    const d = resolveMode('架构好吗', models);
    expect(d.mode).not.toBe('debate');
  });
});
