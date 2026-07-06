/**
 * Agent-bounds wiring (task #45): min_agents / max_agents from config must be
 * intersected with each mode's seat semantics inside executeRoute.
 *   quick   → always {1,1} (exempt)
 *   compare → { max(2, min_agents), min(models, max_agents) }
 *   debate  → { max(3, min_agents), min(models, max_agents) }
 * When the floor exceeds available seats the minimum is clamped and a
 * degradation is raised.
 */
import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../src/core/orchestrator.js';
import type { InvocationAdapter, InvocationResult, HealthStatus } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { Renderer } from '../../src/types/renderer.js';

/** Role-gen response with five valid roles, so the max cap (slice) is exercised
 *  rather than the fallback path (which only ever yields `min` roles). */
const FIVE_ROLES = JSON.stringify(
  Array.from({ length: 5 }, (_, i) => ({
    name: `Role${i + 1}`,
    icon: '🔍',
    description: `expert ${i + 1}`,
    system_prompt: `You are expert ${i + 1}.`,
    assigned_model: '',
  })),
);

/** Adapter that returns a rich 5-role panel for every call (role-gen parses it;
 *  other phases just treat it as opaque text). */
function rolePanelAdapter(): InvocationAdapter {
  return {
    invoke: vi.fn().mockResolvedValue({
      response: FIVE_ROLES,
      elapsed_ms: 10,
      invocation_mode: 'api',
      http_status: 200,
      timed_out: false,
    } satisfies InvocationResult),
    healthCheck: vi.fn().mockResolvedValue({
      level: 'healthy', message: 'OK', checked_at: new Date().toISOString(),
    } satisfies HealthStatus),
  };
}

/** Adapter whose responses never parse as roles → generateRoles falls back to
 *  defaultRoles(min), which is exactly `range.min` agents. Good for floor tests. */
function plainAdapter(): InvocationAdapter {
  return {
    invoke: vi.fn().mockResolvedValue({
      response: 'Mock response',
      elapsed_ms: 10,
      invocation_mode: 'api',
      http_status: 200,
      timed_out: false,
    } satisfies InvocationResult),
    healthCheck: vi.fn().mockResolvedValue({
      level: 'healthy', message: 'OK', checked_at: new Date().toISOString(),
    } satisfies HealthStatus),
  };
}

function createRenderer(): Renderer {
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

function model(name: string, provider: 'anthropic' | 'openai' | 'google' = 'anthropic'): ModelConfig {
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

function fiveModels(): ModelConfig[] {
  return [
    model('claude', 'anthropic'),
    model('gpt', 'openai'),
    model('gemini', 'google'),
    model('claude2', 'anthropic'),
    model('gpt2', 'openai'),
  ];
}

describe('Orchestrator agent bounds', () => {
  it('caps debate panel at max_agents even when more roles are available', async () => {
    const orch = new Orchestrator(
      rolePanelAdapter(), createRenderer(), fiveModels(), undefined, { min: 2, max: 3 },
    );
    const session = await orch.run('Design a resilient distributed system', { mode: 'debate' });
    // upperBound = min(5 models, max_agents 3) = 3; floor = max(3, min_agents 2) = 3.
    expect(session.agents).toHaveLength(3);
  });

  it('raises the compare floor to min_agents', async () => {
    const orch = new Orchestrator(
      plainAdapter(), createRenderer(), fiveModels(), undefined, { min: 4, max: 5 },
    );
    const session = await orch.run('Compare Postgres and MySQL for OLTP', { mode: 'compare' });
    // floor = max(2, min_agents 4) = 4; fallback role-gen yields exactly `min`.
    expect(session.resolved_mode).toBe('compare');
    expect(session.agents).toHaveLength(4);
  });

  it('leaves single-model quick mode at one agent regardless of bounds', async () => {
    const orch = new Orchestrator(
      plainAdapter(), createRenderer(), [model('claude')], undefined, { min: 4, max: 5 },
    );
    const session = await orch.run('Hello', { mode: 'quick' });
    expect(session.resolved_mode).toBe('quick');
    expect(session.agents).toHaveLength(1);
  });

  it('clamps the floor to available seats and raises a degradation when min > max', async () => {
    const renderer = createRenderer();
    // compare + max_agents 2 → upperBound = 2; min_agents 4 → floor 4 > 2.
    const orch = new Orchestrator(
      plainAdapter(), renderer, fiveModels(), undefined, { min: 4, max: 2 },
    );
    const session = await orch.run('Compare A and B', { mode: 'compare' });
    expect(session.agents).toHaveLength(2);
    const clamp = (renderer.onDegradation as ReturnType<typeof vi.fn>).mock.calls
      .map(c => c[0])
      .find((e: { phase: string }) => e.phase === 'route');
    expect(clamp).toBeDefined();
    expect(session.degradation_events?.some(e => e.phase === 'route')).toBe(true);
  });

  it('falls back to schema defaults (min 2 / max 5) when no bounds are injected', async () => {
    const orch = new Orchestrator(plainAdapter(), createRenderer(), fiveModels());
    const session = await orch.run('Compare A and B', { mode: 'compare' });
    // default min 2 → floor max(2,2)=2; fallback yields `min` = 2 agents.
    expect(session.agents).toHaveLength(2);
  });
});
