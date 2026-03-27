import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../src/core/orchestrator.js';
import type { InvocationAdapter, InvocationResult, HealthStatus } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { Renderer } from '../../src/ui/renderer.js';

function createMockAdapter(responseText = 'Mock response'): InvocationAdapter {
  return {
    invoke: vi.fn().mockResolvedValue({
      response: responseText,
      elapsed_ms: 1000,
      invocation_mode: 'api',
      http_status: 200,
      token_usage: { input_tokens: 100, output_tokens: 200 },
      timed_out: false,
    } satisfies InvocationResult),
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

function createModelConfig(name: string, provider: 'anthropic' | 'openai' | 'google' = 'anthropic'): ModelConfig {
  return {
    name,
    invocation: 'api',
    provider,
    model: `${provider}-model`,
    timeout_seconds: 120,
    capabilities: ['general'],
    priority: 100,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: true,
  };
}

describe('Orchestrator', () => {
  it('should create a session and run through phases', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    const models = [
      createModelConfig('claude', 'anthropic'),
      createModelConfig('gemini', 'google'),
    ];

    const orchestrator = new Orchestrator(adapter, renderer, models);
    const session = await orchestrator.run('What is Redis?', { mode: 'compare' });

    expect(session.status).toBe('completed');
    expect(session.question).toBe('What is Redis?');
    expect(session.resolved_mode).toBe('compare');
    expect(session.agents).toHaveLength(2);
    expect(session.synthesis).toBeDefined();
    expect(session.stages).toHaveLength(3); // route, broadcast, synthesis
  });

  it('should handle quick mode with single model', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    const models = [createModelConfig('claude')];

    const orchestrator = new Orchestrator(adapter, renderer, models);
    const session = await orchestrator.run('Hello', { mode: 'quick' });

    expect(session.status).toBe('completed');
    expect(session.resolved_mode).toBe('quick');
    expect(session.stages).toHaveLength(2); // route, broadcast
  });

  it('should auto-resolve mode based on question', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    const models = [
      createModelConfig('claude', 'anthropic'),
      createModelConfig('gemini', 'google'),
    ];

    const orchestrator = new Orchestrator(adapter, renderer, models);
    const session = await orchestrator.run('Redis vs Memcached comparison', { mode: 'auto' });

    expect(session.status).toBe('completed');
    // Should resolve to compare or debate based on keywords
    expect(['compare', 'debate']).toContain(session.resolved_mode);
  });

  it('should assign chairman to first model by default', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    const models = [
      createModelConfig('claude', 'anthropic'),
      createModelConfig('gemini', 'google'),
    ];

    const orchestrator = new Orchestrator(adapter, renderer, models);
    const session = await orchestrator.run('Test', { mode: 'compare' });

    const chairman = session.agents.find(a => a.is_chairman);
    expect(chairman).toBeDefined();
    expect(chairman!.config.name).toBe('claude');
  });

  it('should assign chairman by name when specified', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    const models = [
      createModelConfig('claude', 'anthropic'),
      createModelConfig('gemini', 'google'),
    ];

    const orchestrator = new Orchestrator(adapter, renderer, models, 'gemini');
    const session = await orchestrator.run('Test', { mode: 'compare' });

    const chairman = session.agents.find(a => a.is_chairman);
    expect(chairman).toBeDefined();
    expect(chairman!.config.name).toBe('gemini');
  });

  it('should call adapter.invoke for each agent during broadcast', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    const models = [
      createModelConfig('claude', 'anthropic'),
      createModelConfig('gemini', 'google'),
    ];

    const orchestrator = new Orchestrator(adapter, renderer, models);
    await orchestrator.run('Test question', { mode: 'compare' });

    // 1 role generation + 2 broadcast calls + 1 synthesis call = 4
    expect(adapter.invoke).toHaveBeenCalledTimes(4);
  });

  it('should notify renderer of phase and agent events', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    const models = [
      createModelConfig('claude', 'anthropic'),
      createModelConfig('gemini', 'google'),
    ];

    const orchestrator = new Orchestrator(adapter, renderer, models);
    await orchestrator.run('Test', { mode: 'compare' });

    expect(renderer.onPhaseStart).toHaveBeenCalled();
    expect(renderer.onAgentStart).toHaveBeenCalled();
    expect(renderer.onAgentComplete).toHaveBeenCalled();
  });

  it('should handle adapter failure gracefully', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    (adapter.invoke as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API down'));

    const models = [
      createModelConfig('claude', 'anthropic'),
      createModelConfig('gemini', 'google'),
    ];

    const orchestrator = new Orchestrator(adapter, renderer, models);
    const session = await orchestrator.run('Test', { mode: 'compare' });

    expect(session.status).toBe('failed');
    expect(session.degradation_events).toBeDefined();
    expect(session.degradation_events!.length).toBeGreaterThan(0);
  });

  it('should populate session metadata', async () => {
    const adapter = createMockAdapter();
    const renderer = createMockRenderer();
    const models = [createModelConfig('claude')];

    const orchestrator = new Orchestrator(adapter, renderer, models);
    const session = await orchestrator.run('Test', { mode: 'quick', tags: ['test'] });

    expect(session.session_id).toBeDefined();
    expect(session.question_hash).toBeDefined();
    expect(session.created_at).toBeDefined();
    expect(session.completed_at).toBeDefined();
    expect(session.total_elapsed_ms).toBeDefined();
    expect(session.tags).toEqual(['test']);
  });
});
