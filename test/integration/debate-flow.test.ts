import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../src/core/orchestrator.js';
import type { InvocationAdapter, InvocationResult, HealthStatus } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { Renderer } from '../../src/types/renderer.js';

/**
 * Branch on prompt content rather than a fragile call counter. Role generation,
 * broadcast, review and synthesis calls interleave (and multi-round debates
 * repeat review), so counting calls mis-routes responses. Each prompt kind
 * carries a stable marker string we can match on.
 */
function createMockAdapter(): InvocationAdapter {
  let reviewCount = 0;
  return {
    invoke: vi.fn().mockImplementation(async (_config: unknown, prompt: string) => {
      const base = {
        elapsed_ms: 500 + Math.random() * 2000,
        invocation_mode: 'api' as const,
        http_status: 200,
        token_usage: { input_tokens: 200, output_tokens: 400 },
        timed_out: false,
      };

      // Role generation prompt → return a JSON role array so the panel is well-formed.
      if (prompt.includes('multi-expert debate panel')) {
        return {
          ...base,
          response: JSON.stringify([
            { name: 'Analyst', icon: '🔍', description: 'analysis', system_prompt: 'You analyze.', assigned_model: 'claude' },
            { name: 'Engineer', icon: '⚙️', description: 'engineering', system_prompt: 'You build.', assigned_model: 'gemini' },
            { name: 'Critic', icon: '🎯', description: 'critique', system_prompt: 'You challenge.', assigned_model: 'claude' },
          ]),
        } satisfies InvocationResult;
      }

      // Peer-review prompt → return a JSON review scoring the anonymized answers.
      // Score by descending label so reviewers broadly agree. Under self-review
      // exclusion each reviewer sees only the labels present in ITS prompt
      // (N-1), so parse the labels rather than hard-coding A/B/C.
      if (prompt.includes('evaluating anonymous responses')) {
        reviewCount++;
        const labels = [...prompt.matchAll(/--- Response (\w+) ---/g)].map(m => m[1]!);
        return {
          ...base,
          response: JSON.stringify({
            reviews: labels.map((label, i) => {
              const overall = 9 - i;
              return { label, scores: { accuracy: overall, completeness: overall, practicality: overall, insight: overall, overall }, strengths: 'Strong', weaknesses: 'Minor', ranking: i + 1 };
            }),
          }),
        } satisfies InvocationResult;
      }

      // Synthesis (Chairman) prompt.
      if (prompt.includes('Chairman')) {
        return { ...base, response: 'Synthesized conclusion combining all expert perspectives.' } satisfies InvocationResult;
      }

      // Otherwise a broadcast / cross-examine response.
      return {
        ...base,
        response: `Expert analysis of the topic. Redis is a great choice for caching. (rev ${reviewCount})`,
      } satisfies InvocationResult;
    }),
    healthCheck: vi.fn().mockResolvedValue({
      level: 'healthy',
      message: 'OK',
      checked_at: new Date().toISOString(),
    } satisfies HealthStatus),
  };
}

function createMockRenderer(): Renderer {
  return {
    onPhaseStart: vi.fn(),
    onAgentStart: vi.fn(),
    onAgentProgress: vi.fn(),
    onAgentComplete: vi.fn(),
    onConsensus: vi.fn(),
    onDegradation: vi.fn(),
    renderResult: vi.fn(),
  };
}

function createModels(): ModelConfig[] {
  return [
    {
      name: 'claude', invocation: 'api', provider: 'anthropic',
      model: 'claude-test', timeout_seconds: 120, capabilities: ['general'],
      priority: 100, max_concurrent: 1, resource_weight: 1, enabled: true, streaming: true,
    },
    {
      name: 'gemini', invocation: 'api', provider: 'google',
      model: 'gemini-test', timeout_seconds: 120, capabilities: ['general'],
      priority: 90, max_concurrent: 1, resource_weight: 1, enabled: true, streaming: true,
    },
  ];
}

describe('Full Debate Flow Integration', () => {
  it('should run complete compare mode (broadcast + synthesis)', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    const models = createModels();

    const orchestrator = new Orchestrator(adapter, renderer, models);
    const session = await orchestrator.run('Redis vs Memcached?', { mode: 'compare' });

    expect(session.status).toBe('completed');
    expect(session.resolved_mode).toBe('compare');
    expect(session.synthesis).toBeDefined();
    expect(session.stages.length).toBeGreaterThanOrEqual(2);

    // Should have broadcast and synthesis stages
    const phases = session.stages.map(s => s.phase);
    expect(phases).toContain('broadcast');
    expect(phases).toContain('synthesis');
  });

  it('should run complete debate mode (broadcast + review + consensus + synthesis)', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    const models = createModels();

    const orchestrator = new Orchestrator(adapter, renderer, models);
    const session = await orchestrator.run('Design a microservices architecture', { mode: 'debate' });

    expect(session.status).toBe('completed');
    expect(session.resolved_mode).toBe('debate');
    expect(session.synthesis).toBeDefined();

    const phases = session.stages.map(s => s.phase);
    expect(phases).toContain('broadcast');
    expect(phases).toContain('review');
    expect(phases).toContain('consensus');
    expect(phases).toContain('synthesis');
  });

  it('should compute consensus in debate mode', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    const models = createModels();

    const orchestrator = new Orchestrator(adapter, renderer, models);
    const session = await orchestrator.run('Complex architecture question', { mode: 'debate' });

    expect(session.consensus).toBeDefined();
    expect(session.consensus!.consensus_score).toBeGreaterThanOrEqual(0);
    expect(session.consensus!.consensus_score).toBeLessThanOrEqual(1);
    // agreement_score is the (delta-free) stop criterion; with valid reviews
    // parsed it must be a real value in [0, 1].
    expect(session.consensus!.agreement_score).toBeGreaterThanOrEqual(0);
    expect(session.consensus!.agreement_score).toBeLessThanOrEqual(1);
    // Two providers (anthropic + google) → diversity factor must be > 0.
    expect(session.consensus!.model_diversity_factor).toBeGreaterThan(0);
    // consensus_score is the diversity-discounted view = agreement_score × delta.
    expect(session.consensus!.consensus_score).toBeCloseTo(
      session.consensus!.agreement_score * session.consensus!.model_diversity_factor,
      5,
    );
    expect(renderer.onConsensus).toHaveBeenCalled();
  });

  it('should handle quick mode with minimal phases', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    const models = [createModels()[0]!]; // Single model

    const orchestrator = new Orchestrator(adapter, renderer, models);
    const session = await orchestrator.run('Simple question', { mode: 'quick' });

    expect(session.status).toBe('completed');
    expect(session.resolved_mode).toBe('quick');
    // Quick mode: route + broadcast only
    expect(session.stages).toHaveLength(2);
  });

  it('should auto-resolve mode based on question complexity', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    const models = createModels();

    const orchestrator = new Orchestrator(adapter, renderer, models);

    // Short question → compare
    const session1 = await orchestrator.run('Redis vs Memcached 对比', { mode: 'auto' });
    expect(['compare', 'debate']).toContain(session1.resolved_mode);

    // Complex architecture question → debate
    const session2 = await orchestrator.run(
      'Please discuss and analyze the architecture design tradeoffs of microservices vs monolith for a large-scale e-commerce system',
      { mode: 'auto' },
    );
    expect(session2.resolved_mode).toBe('debate');
  });

  it('feeds aggregated peer criticism into the cross-examine prompt', async () => {
    const prompts: string[] = [];
    let reviewCount = 0;

    const adapter: InvocationAdapter = {
      invoke: vi.fn().mockImplementation(async (_config: unknown, prompt: string) => {
        prompts.push(prompt);
        const base = {
          elapsed_ms: 100, invocation_mode: 'api' as const, http_status: 200,
          token_usage: { input_tokens: 10, output_tokens: 20 }, timed_out: false,
        };

        if (prompt.includes('multi-expert debate panel')) {
          return {
            ...base,
            response: JSON.stringify([
              { name: 'Analyst', icon: '🔍', description: 'a', system_prompt: 'You analyze.', assigned_model: 'claude' },
              { name: 'Engineer', icon: '⚙️', description: 'e', system_prompt: 'You build.', assigned_model: 'gemini' },
              { name: 'Critic', icon: '🎯', description: 'c', system_prompt: 'You challenge.', assigned_model: 'claude' },
            ]),
          } satisfies InvocationResult;
        }

        // Peer-review prompt → strongly divergent rankings across reviewers so
        // agreement_score stays below the stop threshold and cross-examine runs.
        // Labels are parsed from the prompt (self-review exclusion gives each
        // reviewer an N-1 subset), and a per-reviewer rotation scrambles the
        // score order to keep concordance low.
        if (prompt.includes('evaluating anonymous responses')) {
          const labels = [...prompt.matchAll(/--- Response (\w+) ---/g)].map(m => m[1]!);
          const scorePool = [9, 1, 5, 8, 2];
          const offset = reviewCount % labels.length || 0;
          const weaknessMarkers = ['WEAKNESS_MARKER ignores scaling limits', 'WEAKNESS_MARKER no cost analysis', 'WEAKNESS_MARKER weak evidence'];
          reviewCount++;
          return {
            ...base,
            response: JSON.stringify({
              reviews: labels.map((label, i) => {
                const a = scorePool[(i + offset) % scorePool.length]!;
                return { label, scores: { accuracy: a, completeness: a, practicality: a, insight: a, overall: a }, strengths: 'ok', weaknesses: weaknessMarkers[i % weaknessMarkers.length]!, ranking: i + 1 };
              }),
            }),
          } satisfies InvocationResult;
        }

        if (prompt.includes('Chairman')) {
          return { ...base, response: 'Synthesis.' } satisfies InvocationResult;
        }

        return { ...base, response: 'Expert analysis of the topic.' } satisfies InvocationResult;
      }),
      healthCheck: vi.fn().mockResolvedValue({ level: 'healthy', message: 'OK', checked_at: new Date().toISOString() } satisfies HealthStatus),
    };

    const orchestrator = new Orchestrator(adapter, createMockRenderer(), createModels());
    const session = await orchestrator.run('Design a scalable system architecture', { mode: 'debate' });

    // Cross-examine must have run (low agreement) …
    expect(session.stages.some(s => s.phase === 'cross_examine' && s.status === 'completed')).toBe(true);

    // … and its prompt must carry the aggregated peer criticism back to authors.
    const crossExaminePrompts = prompts.filter(p => p.includes('Round 2 of a multi-model debate'));
    expect(crossExaminePrompts.length).toBeGreaterThan(0);
    expect(crossExaminePrompts.some(p => p.includes('WEAKNESS_MARKER'))).toBe(true);
    expect(crossExaminePrompts.some(p => p.includes("Peer reviewers' assessment of your answer"))).toBe(true);
  });

  it('should track timing metadata', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    const models = createModels();

    const orchestrator = new Orchestrator(adapter, renderer, models);
    const session = await orchestrator.run('Timing test', { mode: 'compare' });

    expect(session.created_at).toBeDefined();
    expect(session.completed_at).toBeDefined();
    expect(session.total_elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(session.question_hash).toHaveLength(16);
  });
});
