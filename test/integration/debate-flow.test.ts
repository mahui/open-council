import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../src/core/orchestrator.js';
import type { InvocationAdapter, InvocationResult, HealthStatus } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { Renderer } from '../../src/ui/renderer.js';

function createMockAdapter(): InvocationAdapter {
  let callCount = 0;
  return {
    invoke: vi.fn().mockImplementation(async () => {
      callCount++;
      const isBroadcast = callCount <= 3; // First 3 calls are broadcast
      const isReview = callCount > 3 && callCount <= 6; // Next 3 are review

      if (isReview) {
        // Return JSON review format
        return {
          response: JSON.stringify({
            reviews: [
              {
                label: 'A',
                scores: { accuracy: 8, completeness: 7, practicality: 9, insight: 6, overall: 8 },
                strengths: 'Good analysis',
                weaknesses: 'Could be more specific',
                ranking: 1,
              },
              {
                label: 'B',
                scores: { accuracy: 7, completeness: 8, practicality: 7, insight: 7, overall: 7 },
                strengths: 'Thorough',
                weaknesses: 'Verbose',
                ranking: 2,
              },
            ],
          }),
          elapsed_ms: 500 + Math.random() * 2000,
          invocation_mode: 'api' as const,
          http_status: 200,
          token_usage: { input_tokens: 200, output_tokens: 400 },
          timed_out: false,
        } satisfies InvocationResult;
      }

      return {
        response: isBroadcast
          ? `Expert analysis of the topic from perspective ${callCount}. Redis is a great choice for caching.`
          : `Synthesized conclusion combining all expert perspectives.`,
        elapsed_ms: 1000 + Math.random() * 3000,
        invocation_mode: 'api' as const,
        http_status: 200,
        token_usage: { input_tokens: 150, output_tokens: 300 },
        timed_out: false,
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
    expect(session.consensus!.model_diversity_factor).toBeGreaterThan(0);
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
