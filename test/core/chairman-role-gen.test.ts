import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../src/core/orchestrator.js';
import { rateModelCapability } from '../../src/core/role-generator.js';
import type { InvocationAdapter, InvocationResult, HealthStatus } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { Renderer } from '../../src/types/renderer.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function model(name: string, id: string, priority = 100): ModelConfig {
  return {
    name,
    invocation: 'api',
    provider: 'anthropic',
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

interface AdapterOptions {
  /** Model name whose broadcast answer is marked WINNER (scored highest in review). */
  winner?: string;
  /** Model name whose broadcast returns a much faster elapsed_ms. */
  fast?: string;
  /** Throw on the synthesis (Chairman) call to exercise the fallback path. */
  failSynthesis?: boolean;
}

/**
 * Content-aware mock adapter: inspects the prompt to decide what kind of call
 * it is (role generation / broadcast / review / synthesis) and responds
 * deterministically. Records every (model, prompt) pair for assertions.
 */
function createAdapter(opts: AdapterOptions = {}): { adapter: InvocationAdapter; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const invoke = vi.fn(async (m: ModelConfig, prompt: string): Promise<InvocationResult> => {
    calls.push({ model: m, prompt });
    const base = { invocation_mode: 'api' as const, timed_out: false, elapsed_ms: 1000 };

    // Role-panel generation
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

    // Peer review
    if (prompt.includes('You are a peer reviewer')) {
      const reviews: unknown[] = [];
      const re = /--- Response (\w+) ---\n([\s\S]*?)\n\n/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(prompt)) !== null) {
        const label = mm[1]!;
        const content = mm[2]!;
        const overall = content.includes('WINNER') ? 9 : 5;
        reviews.push({
          label,
          scores: { accuracy: overall, completeness: overall, practicality: overall, insight: overall, overall },
          strengths: 's',
          weaknesses: 'w',
          ranking: overall === 9 ? 1 : 2,
        });
      }
      return { ...base, response: JSON.stringify({ reviews }) };
    }

    // Synthesis (Chairman)
    if (prompt.includes('You are the Chairman synthesizing')) {
      if (opts.failSynthesis) throw new Error('synthesis backend down');
      return { ...base, response: 'SYNTHESIS RESULT' };
    }

    // Broadcast / cross-examine
    const marker = m.name === opts.winner ? ' WINNER' : '';
    const elapsed = m.name === opts.fast ? 10 : 1000;
    return { ...base, elapsed_ms: elapsed, response: `Answer from ${m.name}${marker}` };
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

function roleGenCall(calls: RecordedCall[]): RecordedCall | undefined {
  return calls.find(c => c.prompt.includes('multi-expert debate panel'));
}

// ---------------------------------------------------------------------------
// rateModelCapability
// ---------------------------------------------------------------------------

describe('rateModelCapability', () => {
  it('rates strong-reasoning models as tier 3', () => {
    expect(rateModelCapability(model('a', 'claude-opus-4'))).toBe(3);
    expect(rateModelCapability(model('b', 'gemini-2.5-pro'))).toBe(3);
    expect(rateModelCapability(model('c', 'gpt-5.3'))).toBe(3);
    expect(rateModelCapability(model('d', 'o3'))).toBe(3);
  });

  it('rates balanced models as tier 2', () => {
    expect(rateModelCapability(model('a', 'claude-sonnet-4'))).toBe(2);
    expect(rateModelCapability(model('b', 'gemini-flash'))).toBe(2);
    expect(rateModelCapability(model('c', 'gpt-4o'))).toBe(2);
  });

  it('rates fast/lightweight models as tier 1', () => {
    expect(rateModelCapability(model('a', 'claude-haiku'))).toBe(1);
    expect(rateModelCapability(model('b', 'o1-mini'))).toBe(1);
    expect(rateModelCapability(model('c', 'gemini-lite'))).toBe(1);
  });

  it('defaults unrecognized ids to balanced (tier 2)', () => {
    expect(rateModelCapability(model('a', 'mystery-model'))).toBe(2);
  });

  it('uses the model id in preference to the name', () => {
    // name looks fast, but the real model id is strong
    expect(rateModelCapability(model('haiku', 'claude-opus-4'))).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Task #12 — chairman selection
// ---------------------------------------------------------------------------

describe('Orchestrator chairman selection', () => {
  it('picks the strongest model as chairman even when it is not first', async () => {
    const { adapter } = createAdapter();
    const models = [
      model('fast', 'claude-haiku'),   // tier 1, first in list
      model('strong', 'claude-opus-4'), // tier 3
    ];
    const orch = new Orchestrator(adapter, createRenderer(), models);
    const session = await orch.run('Compare A and B', { mode: 'compare' });

    const chairman = session.agents.find(a => a.is_chairman);
    expect(chairman?.config.name).toBe('strong');
  });

  it('breaks capability ties by higher config priority (lower number)', async () => {
    const { adapter } = createAdapter();
    const models = [
      model('balanced-lo', 'claude-sonnet-4', 100), // tier 2, priority 100
      model('balanced-hi', 'claude-sonnet-4', 50),  // tier 2, priority 50 -> preferred
    ];
    const orch = new Orchestrator(adapter, createRenderer(), models);
    const session = await orch.run('Compare A and B', { mode: 'compare' });

    const chairman = session.agents.find(a => a.is_chairman);
    expect(chairman?.config.name).toBe('balanced-hi');
  });

  it('honors an explicit default chairman over capability heuristics', async () => {
    const { adapter } = createAdapter();
    const models = [
      model('strong', 'claude-opus-4'),
      model('fast', 'claude-haiku'),
    ];
    const orch = new Orchestrator(adapter, createRenderer(), models, 'fast');
    const session = await orch.run('Compare A and B', { mode: 'compare' });

    const chairman = session.agents.find(a => a.is_chairman);
    expect(chairman?.config.name).toBe('fast');
  });
});

// ---------------------------------------------------------------------------
// Task #12 — synthesis fallback picks best answer by review score
// ---------------------------------------------------------------------------

describe('Orchestrator synthesis fallback', () => {
  it('falls back to the highest peer-reviewed answer when synthesis fails', async () => {
    const { adapter } = createAdapter({ failSynthesis: true, winner: 'beta' });
    const models = [
      model('alpha', 'claude-sonnet-4'),
      model('beta', 'gemini-flash'),
      model('gamma', 'gpt-4o'),
    ];
    const orch = new Orchestrator(adapter, createRenderer(), models);
    const session = await orch.run('Debate this thoroughly, pros and cons', { mode: 'debate' });

    // Synthesis backend threw -> fallback should output the best-reviewed answer,
    // which is beta's WINNER-marked response (aggregate review score 9 vs 5).
    expect(session.synthesis).toBe('Answer from beta WINNER');
  });

  it('falls back to the fastest answer when no review data exists (compare mode)', async () => {
    const { adapter } = createAdapter({ failSynthesis: true, fast: 'speedy' });
    const models = [
      model('slowpoke', 'claude-sonnet-4'),
      model('speedy', 'gemini-flash'),
    ];
    const orch = new Orchestrator(adapter, createRenderer(), models);
    const session = await orch.run('Compare A and B', { mode: 'compare' });

    expect(session.synthesis).toBe('Answer from speedy');
  });
});

// ---------------------------------------------------------------------------
// Task #13 — quick mode skips role generation
// ---------------------------------------------------------------------------

describe('Orchestrator quick mode', () => {
  it('does not invoke the LLM for role generation in quick mode', async () => {
    const { adapter, calls } = createAdapter();
    const models = [
      model('alpha', 'claude-sonnet-4'),
      model('beta', 'gemini-flash'),
    ];
    const orch = new Orchestrator(adapter, createRenderer(), models);
    const session = await orch.run('Hello there', { mode: 'quick' });

    expect(session.resolved_mode).toBe('quick');
    expect(session.agents).toHaveLength(1);
    // No role-generation call should have been made.
    expect(roleGenCall(calls)).toBeUndefined();
    // Only the single broadcast call.
    expect(adapter.invoke).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Task #13 — role generator model configurable
// ---------------------------------------------------------------------------

describe('Orchestrator role-generator model selection', () => {
  it('uses an explicitly configured role-generator model', async () => {
    const { adapter, calls } = createAdapter();
    const models = [
      model('strong', 'claude-opus-4'),
      model('balanced', 'claude-sonnet-4'),
      model('fast', 'claude-haiku'),
    ];
    const roleGen = model('fast', 'claude-haiku');
    const orch = new Orchestrator(adapter, createRenderer(), models, undefined, undefined, roleGen);
    await orch.run('Compare these options carefully', { mode: 'compare' });

    expect(roleGenCall(calls)?.model.name).toBe('fast');
  });

  it('defaults to a balanced-tier model for role generation', async () => {
    const { adapter, calls } = createAdapter();
    const models = [
      model('strong', 'claude-opus-4'),   // tier 3
      model('balanced', 'claude-sonnet-4'), // tier 2 -> preferred designer
      model('fast', 'claude-haiku'),       // tier 1
    ];
    const orch = new Orchestrator(adapter, createRenderer(), models);
    await orch.run('Compare these options carefully', { mode: 'compare' });

    expect(roleGenCall(calls)?.model.name).toBe('balanced');
  });
});

// ---------------------------------------------------------------------------
// Task #46 — routing.default.prefer drives role-gen candidate ordering + cap
// ---------------------------------------------------------------------------

/** Extract the model names, in listing order, from a role-generation prompt. */
function listedModels(prompt: string): string[] {
  return [...prompt.matchAll(/^\s*\d+\.\s+([^\s(]+)/gm)].map(mm => mm[1]!);
}

describe('Orchestrator prefer ordering', () => {
  // 12 same-tier models (unrecognized ids → tier 2) so ordering is governed
  // purely by preferOrder, then stable original order for the rest.
  const twelve = (): ModelConfig[] =>
    Array.from({ length: 12 }, (_, i) => model(`m${String(i).padStart(2, '0')}`, `mystery-${i}`));

  it('promotes prefer-listed models to the front of the role-gen candidate list', async () => {
    const { adapter, calls } = createAdapter();
    // m11 and m09 would otherwise sit at the back (and m11 would be truncated away).
    const orch = new Orchestrator(
      adapter, createRenderer(), twelve(),
      undefined, undefined, undefined, undefined, ['m11', 'm09'],
    );
    await orch.run('Compare these options carefully', { mode: 'compare' });

    const listed = listedModels(roleGenCall(calls)!.prompt);
    // Cap = max(range.max(5) * 2, 8) = 10.
    expect(listed).toHaveLength(10);
    // Preferred models come first, in the order they were listed in prefer.
    expect(listed[0]).toBe('m11');
    expect(listed[1]).toBe('m09');
    // A would-be-truncated model survives *because* it was preferred.
    expect(listed).toContain('m11');
  });

  it('matches prefer entries by model id as well as name', async () => {
    const { adapter, calls } = createAdapter();
    const orch = new Orchestrator(
      adapter, createRenderer(), twelve(),
      undefined, undefined, undefined, undefined, ['mystery-10'],
    );
    await orch.run('Compare these options carefully', { mode: 'compare' });

    const listed = listedModels(roleGenCall(calls)!.prompt);
    expect(listed[0]).toBe('m10');
  });

  it('caps the candidate list even without any prefer configured', async () => {
    const { adapter, calls } = createAdapter();
    const orch = new Orchestrator(adapter, createRenderer(), twelve());
    await orch.run('Compare these options carefully', { mode: 'compare' });

    expect(listedModels(roleGenCall(calls)!.prompt)).toHaveLength(10);
  });
});
