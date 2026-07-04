import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { rolesFromRoleSet } from '../../src/core/role-generator.js';
import type { InvocationAdapter, InvocationResult, HealthStatus } from '../../src/types/provider.js';
import type { ModelConfig, RoleSet } from '../../src/types/config.js';
import type { Renderer } from '../../src/types/renderer.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function model(name: string, provider: string, id: string, priority = 100): ModelConfig {
  return {
    name,
    invocation: 'api',
    provider,
    model: id,
    timeout_seconds: 120,
    capabilities: ['general'],
    priority,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: true,
  };
}

interface RecordedCall {
  model: ModelConfig;
  prompt: string;
}

/**
 * Content-aware mock adapter mirroring the pattern in chairman-role-gen.test.ts:
 * classifies each prompt (role-gen / review / synthesis / broadcast) and answers
 * deterministically, recording every (model, prompt) pair for assertions.
 */
function createAdapter(): { adapter: InvocationAdapter; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const invoke = vi.fn(async (m: ModelConfig, prompt: string): Promise<InvocationResult> => {
    calls.push({ model: m, prompt });
    const base = { invocation_mode: 'api' as const, timed_out: false, elapsed_ms: 1000 };

    if (prompt.includes('multi-expert debate panel')) {
      const names = [...prompt.matchAll(/^\s*\d+\.\s+([^\s(]+)/gm)].map(mm => mm[1]);
      const roles = names.map(n => ({
        name: `Role ${n}`,
        icon: '🤖',
        description: 'test role',
        system_prompt: 'You are a test expert.',
        assigned_model: n,
      }));
      return { ...base, response: JSON.stringify(roles) };
    }

    if (prompt.includes('You are a peer reviewer')) {
      const reviews: unknown[] = [];
      const re = /--- Response (\w+) ---\n([\s\S]*?)\n\n/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(prompt)) !== null) {
        const label = mm[1]!;
        reviews.push({
          label,
          scores: { accuracy: 5, completeness: 5, practicality: 5, insight: 5, overall: 5 },
          strengths: 's',
          weaknesses: 'w',
          ranking: 1,
        });
      }
      return { ...base, response: JSON.stringify({ reviews }) };
    }

    if (prompt.includes('You are the Chairman synthesizing')) {
      return { ...base, response: 'SYNTHESIS RESULT' };
    }

    return { ...base, response: `Answer from ${m.name}` };
  });

  return {
    adapter: {
      invoke,
      healthCheck: vi.fn().mockResolvedValue({
        level: 'healthy', message: 'OK', checked_at: new Date().toISOString(),
      } satisfies HealthStatus),
    },
    calls,
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

function usedRoleGen(calls: RecordedCall[]): boolean {
  return calls.some(c => c.prompt.includes('multi-expert debate panel'));
}

const SAMPLE_ROLE_SET: RoleSet = {
  version: '1.0.0',
  roles: {
    analyst: { description: '分析师', system_prompt: 'You analyze.', assign_to: ['anthropic'] },
    engineer: { description: '工程师', system_prompt: 'You build.', assign_to: ['google', 'gemini'] },
    innovator: { description: '创新者', system_prompt: 'You innovate.', assign_to: ['openai', 'gpt'] },
  },
};

// ---------------------------------------------------------------------------
// rolesFromRoleSet — pure mapping + model assignment
// ---------------------------------------------------------------------------

describe('rolesFromRoleSet', () => {
  const models = [
    model('claude', 'anthropic', 'claude-sonnet-4'),
    model('gemini', 'google', 'gemini-2.5-pro'),
    model('gpt', 'openai', 'gpt-5'),
  ];

  it('maps each template role to a GeneratedRole preserving key, description, prompt', () => {
    const roles = rolesFromRoleSet(SAMPLE_ROLE_SET, models);
    expect(roles.map(r => r.name)).toEqual(['analyst', 'engineer', 'innovator']);
    expect(roles[0]!.description).toBe('分析师');
    expect(roles[0]!.system_prompt).toBe('You analyze.');
  });

  it('resolves assign_to preference against provider / name / id', () => {
    const roles = rolesFromRoleSet(SAMPLE_ROLE_SET, models);
    expect(roles[0]!.assigned_model).toBe('claude');  // provider "anthropic"
    expect(roles[1]!.assigned_model).toBe('gemini');  // provider "google"
    expect(roles[2]!.assigned_model).toBe('gpt');     // provider "openai" / name "gpt"
  });

  it('falls back to round-robin when no assign_to preference matches', () => {
    const roleSet: RoleSet = {
      version: '1.0.0',
      roles: {
        a: { description: 'a', system_prompt: 'p', assign_to: ['nonexistent-provider'] },
        b: { description: 'b', system_prompt: 'p', assign_to: [] },
        c: { description: 'c', system_prompt: 'p', assign_to: ['also-missing'] },
      },
    };
    const roles = rolesFromRoleSet(roleSet, models);
    // Round-robin by role index: 0→models[0], 1→models[1], 2→models[2].
    expect(roles.map(r => r.assigned_model)).toEqual(['claude', 'gemini', 'gpt']);
  });

  it('matches assign_to by model id substring', () => {
    const roleSet: RoleSet = {
      version: '1.0.0',
      roles: {
        a: { description: 'a', system_prompt: 'p', assign_to: ['gpt-5'] },
      },
    };
    const roles = rolesFromRoleSet(roleSet, models);
    expect(roles[0]!.assigned_model).toBe('gpt');
  });
});

// ---------------------------------------------------------------------------
// Orchestrator — explicit --role-set override path
// ---------------------------------------------------------------------------

describe('Orchestrator explicit role-set override', () => {
  const models = [
    model('claude', 'anthropic', 'claude-sonnet-4'),
    model('gemini', 'google', 'gemini-2.5-pro'),
    model('gpt', 'openai', 'gpt-5'),
  ];

  it('uses template roles and skips the role-generation LLM call', async () => {
    const { adapter, calls } = createAdapter();
    const orch = new Orchestrator(
      adapter, createRenderer(), models, undefined, undefined, undefined, SAMPLE_ROLE_SET,
    );
    const session = await orch.run('Design a system', { mode: 'debate' });

    expect(usedRoleGen(calls)).toBe(false);
    // Template role keys become the agent role names.
    const roleNames = session.agents.map(a => a.role);
    expect(roleNames).toContain('🤖 analyst');
    expect(roleNames).toContain('🤖 engineer');
    expect(roleNames).toContain('🤖 innovator');
  });

  it('assigns models to agents per the template assign_to preferences', async () => {
    const { adapter } = createAdapter();
    const orch = new Orchestrator(
      adapter, createRenderer(), models, undefined, undefined, undefined, SAMPLE_ROLE_SET,
    );
    const session = await orch.run('Design a system', { mode: 'debate' });

    const byRole = new Map(session.agents.map(a => [a.role, a.config.name]));
    expect(byRole.get('🤖 analyst')).toBe('claude');
    expect(byRole.get('🤖 engineer')).toBe('gemini');
    expect(byRole.get('🤖 innovator')).toBe('gpt');
  });

  it('caps template roles at the mode upper bound (agents <= available models)', async () => {
    const { adapter } = createAdapter();
    const twoModels = [
      model('claude', 'anthropic', 'claude-sonnet-4'),
      model('gemini', 'google', 'gemini-2.5-pro'),
    ];
    const orch = new Orchestrator(
      adapter, createRenderer(), twoModels, undefined, undefined, undefined, SAMPLE_ROLE_SET,
    );
    // compare mode with 2 models → upper bound 2, so the 3-role set is capped.
    const session = await orch.run('Compare A and B', { mode: 'compare' });
    expect(session.agents).toHaveLength(2);
  });

  it('does not regress dynamic generation when no role set is provided', async () => {
    const { adapter, calls } = createAdapter();
    const orch = new Orchestrator(adapter, createRenderer(), models);
    await orch.run('Design a system', { mode: 'debate' });

    // Without an explicit role set, the LLM role-panel designer must run.
    expect(usedRoleGen(calls)).toBe(true);
  });
});
