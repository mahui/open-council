import { describe, it, expect } from 'vitest';
import { resolveMode, classifyQuestion, allocateSeats } from '../../src/core/router.js';
import type { ModelConfig, CouncilConfig, RoleSet } from '../../src/types/config.js';

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

/** Minimal but complete `general` config block, with sensible defaults, for allocateSeats(). */
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

  it('caps seats at the model count in quick mode', () => {
    const models = [makeModel('claude', 'anthropic'), makeModel('gemini', 'google'), makeModel('gpt', 'openai')];
    const result = allocateSeats({
      models,
      options: { mode: 'quick' },
      questionType: 'general',
      resolvedMode: 'quick',
      config: makeGeneralConfig({ max_agents: 2 }),
    });
    // Quick mode: min(models.length, maxAgents) = min(3, 2) = 2 seats.
    expect(result.agents).toHaveLength(2);
  });

  it('reuses models round-robin to reach min_agents when a single model is available', () => {
    const models = [makeModel('claude', 'anthropic')];
    const result = allocateSeats({
      models,
      options: { mode: 'quick' },
      questionType: 'general',
      resolvedMode: 'quick',
      config: makeGeneralConfig({ min_agents: 3, max_agents: 5 }),
    });
    // Quick mode allocates 1 seat initially, then the min-seats loop tops up to 3.
    expect(result.agents).toHaveLength(3);
    expect(result.agents.every(a => a.config.name === 'claude')).toBe(true);
  });

  it('stops allocating once models run out when same-model reuse is disallowed', () => {
    const models = [makeModel('claude', 'anthropic'), makeModel('gemini', 'google')];
    const result = allocateSeats({
      models,
      options: { mode: 'compare' },
      questionType: 'general',
      resolvedMode: 'compare',
      config: makeGeneralConfig({ min_agents: 2, max_agents: 5, allow_same_model_agents: false }),
    });
    // 5 default roles requested but only 2 distinct models exist and reuse is disallowed.
    expect(result.agents).toHaveLength(2);
  });

  it('prefers a model whose capabilities match the question type over the round-robin default', () => {
    const models = [
      makeModel('generalist', 'anthropic', ['general'], 10),
      makeModel('coder', 'openai', ['code'], 90),
    ];
    const result = allocateSeats({
      models,
      options: { mode: 'compare' },
      questionType: 'code',
      resolvedMode: 'compare',
      config: makeGeneralConfig({ min_agents: 2, max_agents: 2 }),
    });
    // Seat 0 would default to 'generalist' (index 0), but 'coder' has the
    // required 'code' capability and is unused, so it should be preferred.
    expect(result.agents[0]!.config.name).toBe('coder');
  });

  it('assigns the chairman by explicit name when provided', () => {
    const models = [makeModel('claude', 'anthropic'), makeModel('gemini', 'google')];
    const result = allocateSeats({
      models,
      options: { mode: 'compare', chairman: 'gemini' },
      questionType: 'general',
      resolvedMode: 'compare',
    });
    const chairman = result.agents.find(a => a.is_chairman);
    expect(chairman?.config.name).toBe('gemini');
  });

  it('assigns a devil\'s advocate in debate mode with 3+ agents', () => {
    const models = [makeModel('claude', 'anthropic'), makeModel('gemini', 'google'), makeModel('gpt', 'openai')];
    const result = allocateSeats({
      models,
      options: { mode: 'debate' },
      questionType: 'general',
      resolvedMode: 'debate',
      config: makeGeneralConfig({ min_agents: 3, max_agents: 3 }),
    });
    expect(result.agents.filter(a => a.is_devil_advocate)).toHaveLength(1);
    // Devil's advocate must never be the chairman.
    expect(result.agents.find(a => a.is_devil_advocate)?.is_chairman).toBe(false);
  });

  it('does not assign a devil\'s advocate outside debate mode', () => {
    const models = [makeModel('claude', 'anthropic'), makeModel('gemini', 'google'), makeModel('gpt', 'openai')];
    const result = allocateSeats({
      models,
      options: { mode: 'compare' },
      questionType: 'general',
      resolvedMode: 'compare',
      config: makeGeneralConfig({ min_agents: 3, max_agents: 3 }),
    });
    expect(result.agents.some(a => a.is_devil_advocate)).toBe(false);
  });

  it('uses role names and descriptions from a custom role set when provided', () => {
    const roleSet: RoleSet = {
      version: '1',
      roles: {
        custom_lead: { description: 'Leads the custom effort', system_prompt: 'You lead.', assign_to: [] },
        custom_reviewer: { description: 'Reviews the custom effort', system_prompt: 'You review.', assign_to: [] },
      },
    };
    const models = [makeModel('claude', 'anthropic'), makeModel('gemini', 'google')];
    const result = allocateSeats({
      models,
      options: { mode: 'compare' },
      questionType: 'general',
      resolvedMode: 'compare',
      roleSet,
    });
    expect(result.agents.map(a => a.role)).toEqual(expect.arrayContaining(['custom_lead', 'custom_reviewer']));
    const lead = result.agents.find(a => a.role === 'custom_lead')!;
    expect(lead.role_description).toBe('Leads the custom effort');
    expect(lead.system_prompt).toBe('You lead.');
  });

  it('promotes the engineer role to the front for code questions (no role set)', () => {
    const models = [makeModel('claude', 'anthropic'), makeModel('gemini', 'google')];
    const result = allocateSeats({
      models,
      options: { mode: 'compare' },
      questionType: 'code',
      resolvedMode: 'compare',
      config: makeGeneralConfig({ min_agents: 2, max_agents: 2 }),
    });
    expect(result.agents[0]!.role).toBe('engineer');
  });

  it('promotes the innovator role to the front for creative questions (no role set)', () => {
    const models = [makeModel('claude', 'anthropic'), makeModel('gemini', 'google')];
    const result = allocateSeats({
      models,
      options: { mode: 'compare' },
      questionType: 'creative',
      resolvedMode: 'compare',
      config: makeGeneralConfig({ min_agents: 2, max_agents: 2 }),
    });
    expect(result.agents[0]!.role).toBe('innovator');
  });

  it('reports the suggested role set inferred from question type when no override given', () => {
    const models = [makeModel('claude', 'anthropic'), makeModel('gemini', 'google')];
    const result = allocateSeats({
      models,
      options: { mode: 'compare' },
      questionType: 'code',
      resolvedMode: 'compare',
    });
    expect(result.roleSetUsed).toBe('code-review');
  });
});
