import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../src/core/orchestrator.js';
import type { InvocationAdapter, InvocationResult, HealthStatus } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { DebateMode } from '../../src/types/session.js';
import type { Renderer } from '../../src/ui/renderer.js';

/**
 * Targeted gap-fill tests for Orchestrator branches not exercised by the main
 * orchestrator.test.ts / chairman-role-gen.test.ts / self-review-exclusion.test.ts
 * suites: per-run model filtering, defensive fallbacks, devil's advocate
 * assignment, degraded broadcast/cross-examine paths, pre-synthesis compression
 * triggering, and truncation notification.
 */

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

interface RecordedCall { model: ModelConfig; prompt: string }

interface GapAdapterOptions {
  /** model name -> broadcast response text, or 'THROW' to reject that model's broadcast call. */
  broadcast?: Record<string, string | 'THROW'>;
  /** Fixed overall score (1-10) a given reviewer (by model name) assigns to every label it reviews. */
  reviewerScore?: (reviewerName: string) => number;
  /** Overall score (1-10) derived from the reviewed answer's own content (stable across reviewers/shuffles). */
  reviewScoreForContent?: (content: string) => number;
  /** model name -> cross-examine response text (used every round), or 'THROW'. */
  crossExamine?: Record<string, string | 'THROW'>;
  /** Model names whose broadcast response should be flagged `truncated: true`. */
  truncatedFor?: string[];
  failSynthesis?: boolean;
  /** Model names whose peer-review call should reject (individual review failure). */
  reviewFailFor?: string[];
}

/**
 * Content-aware mock adapter shared by the gap-fill tests below. Dispatches on
 * distinctive prompt substrings (role-gen / review / cross-examine / synthesis
 * / broadcast) the same way chairman-role-gen.test.ts and
 * self-review-exclusion.test.ts do, so behavior stays a black-box
 * input/output contract (TEST-03) rather than reaching into orchestrator
 * internals.
 */
function createGapAdapter(opts: GapAdapterOptions = {}): { adapter: InvocationAdapter; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];

  const invoke = vi.fn(async (m: ModelConfig, prompt: string, onChunk?: (c: string) => void): Promise<InvocationResult> => {
    calls.push({ model: m, prompt });
    onChunk?.('...chunk...');
    const base = { invocation_mode: 'api' as const, timed_out: false, elapsed_ms: 100 };

    // Role-panel generation: assign each generated role to a distinct model, in list order.
    if (prompt.includes('multi-expert debate panel')) {
      const names = [...prompt.matchAll(/^\s*\d+\.\s+([^\s(]+)/gm)].map(mm => mm[1]!);
      const roles = names.map((n, i) => ({
        name: `Role ${i}`, icon: '🤖', description: 'test role', system_prompt: `You are role ${i}.`,
        assigned_model: n,
      }));
      return { ...base, response: JSON.stringify(roles) };
    }

    // Peer review (standard or devil's-advocate variant).
    if (prompt.includes('You are a peer reviewer') || prompt.includes('Devil\'s Advocate')) {
      if (opts.reviewFailFor?.includes(m.name)) throw new Error(`review down for ${m.name}`);
      // Two scoring strategies: content-based (a stable per-item ranking every
      // reviewer agrees on, regardless of shuffle order — needed to reliably
      // reach high agreement and stop the cross-examine loop after round 0) or
      // reviewer-identity-based (fixed per-reviewer score, used to reliably
      // produce LOW / discordant agreement so the round loop keeps going).
      const entries = [...prompt.matchAll(/--- Response (\w+) ---\n([\s\S]*?)\n\n/g)]
        .map(mm => ({ label: mm[1]!, content: mm[2]! }));
      const reviews = entries.map(({ label, content }) => {
        const overall = opts.reviewScoreForContent
          ? opts.reviewScoreForContent(content)
          : opts.reviewerScore
            ? opts.reviewerScore(m.name)
            : 7;
        return {
          label,
          scores: { accuracy: overall, completeness: overall, practicality: overall, insight: overall, overall },
          strengths: 's', weaknesses: 'w', ranking: 1,
        };
      });
      return { ...base, response: JSON.stringify({ reviews }) };
    }

    // Synthesis (Chairman).
    if (prompt.includes('You are the Chairman synthesizing')) {
      if (opts.failSynthesis) throw new Error('synthesis backend down');
      return { ...base, response: 'SYNTHESIS RESULT' };
    }

    // Cross-examine (any round).
    if (/Round \d+ of a multi-model debate/.test(prompt)) {
      const behavior = opts.crossExamine?.[m.name];
      if (behavior === 'THROW') throw new Error(`cross-examine down for ${m.name}`);
      return { ...base, response: behavior ?? `${m.name} revised answer` };
    }

    // Broadcast.
    const behavior = opts.broadcast?.[m.name];
    if (behavior === 'THROW') throw new Error(`broadcast down for ${m.name}`);
    const truncated = opts.truncatedFor?.includes(m.name) ?? false;
    return { ...base, response: behavior ?? `Answer from ${m.name}`, truncated };
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

describe('Orchestrator.run — per-run model filter', () => {
  it('restricts agents to the requested subset without mutating later calls', async () => {
    const { adapter } = createGapAdapter();
    const models = [model('claude'), model('gemini', 'google'), model('gpt', 'openai')];
    const orch = new Orchestrator(adapter, createRenderer(), models);

    const filtered = await orch.run('Compare A and B', { mode: 'compare', models: ['claude', 'gemini'] });
    expect(filtered.agents.every(a => ['claude', 'gemini'].includes(a.config.name))).toBe(true);
    expect(filtered.agents.some(a => a.config.name === 'gpt')).toBe(false);

    // A subsequent call on the SAME instance must see all 3 models again.
    const unfiltered = await orch.run('Compare A and B', { mode: 'compare' });
    expect(new Set(unfiltered.agents.map(a => a.config.name)).size).toBeGreaterThanOrEqual(2);
  });
});

describe('Orchestrator.run — unrecognized resolved mode', () => {
  it('falls back to the compare phase sequence for a mode outside the known set', async () => {
    const { adapter } = createGapAdapter();
    const models = [model('claude'), model('gemini', 'google')];
    const orch = new Orchestrator(adapter, createRenderer(), models);

    // Out-of-contract input on purpose: exercises the `?? PHASE_SEQUENCES.compare`
    // defensive fallback, which no valid DebateMode value can otherwise reach.
    const session = await orch.run('Test', { mode: 'bogus-mode' as unknown as DebateMode });

    expect(session.stages.map(s => s.phase)).toEqual(['route', 'broadcast', 'synthesis']);
    expect(session.status).toBe('completed');
  });
});

describe('Orchestrator.run — devil\'s advocate assignment', () => {
  it('assigns exactly one non-chairman agent as devil\'s advocate in debate mode', async () => {
    const { adapter, calls } = createGapAdapter();
    const models = [model('claude'), model('gemini', 'google'), model('gpt', 'openai')];
    const orch = new Orchestrator(adapter, createRenderer(), models);

    const session = await orch.run('Design a resilient payment system', { mode: 'debate', devilAdvocate: true });

    const advocates = session.agents.filter(a => a.is_devil_advocate);
    expect(advocates).toHaveLength(1);
    expect(advocates[0]!.is_chairman).toBe(false);

    // The devil's-advocate reviewer must receive the augmented review prompt.
    const devilPrompts = calls.filter(c => c.prompt.includes('Devil\'s Advocate'));
    expect(devilPrompts.length).toBeGreaterThan(0);
  });
});

describe('Orchestrator.run — self-review exclusion edge case', () => {
  it('gives a reviewer with no own answer the full anonymized set (recorded under its id)', async () => {
    const { adapter } = createGapAdapter({ broadcast: { straggler: 'THROW' } });
    const models = [
      model('claude'), model('gemini', 'google'), model('gpt', 'openai'), model('straggler', 'openai'),
    ];
    const orch = new Orchestrator(adapter, createRenderer(), models);

    const session = await orch.run('Design a scalable architecture with tradeoffs', { mode: 'debate' });

    const reviewStage = session.stages.filter(s => s.phase === 'review' && s.status === 'completed').pop();
    expect(reviewStage?.reviewer_label_maps).toBeDefined();

    const straggler = session.agents.find(a => a.config.name === 'straggler')!;
    const stragglerMap = reviewStage!.reviewer_label_maps![straggler.agent_id];
    expect(stragglerMap).toBeDefined();
    // The straggler had no own answer to exclude, so it reviews the FULL set (3 answers).
    expect(Object.keys(stragglerMap!)).toHaveLength(3);
  });
});

describe('Orchestrator.run — degraded review', () => {
  it('records a degradation event and keeps the other reviews when one reviewer fails', async () => {
    const { adapter } = createGapAdapter({ reviewFailFor: ['gpt'] });
    const models = [model('claude'), model('gemini', 'google'), model('gpt', 'openai')];
    const renderer = createRenderer();
    const orch = new Orchestrator(adapter, renderer, models);

    const session = await orch.run('Design a scalable architecture with tradeoffs', { mode: 'debate' });

    expect(session.status).toBe('completed');
    expect(renderer.onDegradation).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'review', impact: expect.stringContaining('gpt') }),
    );
    const reviewStage = session.stages.find(s => s.phase === 'review')!;
    // claude and gemini's reviews still landed even though gpt's failed.
    expect(reviewStage.invocations.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Orchestrator.run — degraded cross-examine', () => {
  it('keeps the round going when only some agents succeed cross-examine', async () => {
    const { adapter } = createGapAdapter({
      reviewerScore: (name) => ({ claude: 9, gemini: 2, gpt: 6 }[name] ?? 5),
      crossExamine: { gemini: 'THROW' },
    });
    const models = [model('claude'), model('gemini', 'google'), model('gpt', 'openai')];
    const orch = new Orchestrator(adapter, createRenderer(), models);

    const session = await orch.run('Design a scalable architecture with tradeoffs', { mode: 'debate' });

    expect(session.status).toBe('completed');
    const crossExamineStage = session.stages.find(s => s.phase === 'cross_examine');
    expect(crossExamineStage).toBeDefined();
    expect(crossExamineStage!.status).toBe('completed');
    const gemini = session.agents.find(a => a.config.name === 'gemini')!;
    expect(crossExamineStage!.invocations.some(i => i.agent_id === gemini.agent_id)).toBe(false);
    expect(crossExamineStage!.invocations.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Orchestrator.run — cross-examine collapses to empty responses', () => {
  it('skips later rounds once too few valid answers remain and reports synthesis as empty', async () => {
    const { adapter } = createGapAdapter({
      reviewerScore: (name) => ({ claude: 9, gemini: 2, gpt: 6 }[name] ?? 5),
      // Every agent "revises" to an empty string every round — a resolved (not
      // thrown) call, so the stage still completes, but with zero valid content.
      crossExamine: { claude: '', gemini: '', gpt: '' },
    });
    const models = [model('claude'), model('gemini', 'google'), model('gpt', 'openai')];
    const renderer = createRenderer();
    const orch = new Orchestrator(adapter, renderer, models);

    const session = await orch.run('Design a scalable architecture with tradeoffs', { mode: 'debate' });

    const crossExamineStages = session.stages.filter(s => s.phase === 'cross_examine');
    // Round 1 "completes" (agents responded, just emptily); a later round finds
    // fewer than 2 valid answers in the prior stage and is skipped outright.
    expect(crossExamineStages.some(s => s.status === 'skipped')).toBe(true);

    expect(renderer.onDegradation).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'synthesis', reason: 'All agent responses empty' }),
    );
  });
});

describe('Orchestrator.run — single surviving response reaches synthesis directly', () => {
  it('uses the lone successful broadcast response as the synthesis verbatim (compare mode)', async () => {
    const { adapter, calls } = createGapAdapter({ broadcast: { gemini: 'THROW' } });
    const models = [model('claude'), model('gemini', 'google')];
    const orch = new Orchestrator(adapter, createRenderer(), models);

    const session = await orch.run('Compare A and B', { mode: 'compare' });

    expect(session.synthesis).toBe('Answer from claude');
    // The single-response shortcut must bypass the Chairman synthesis call entirely.
    expect(calls.some(c => c.prompt.includes('You are the Chairman synthesizing'))).toBe(false);
  });

  it('skips consensus computation when broadcast degrades to a single valid response (debate mode)', async () => {
    // Debate mode always designs >= 3 seats (see executeRoute); with only 2
    // distinct models available, generateRoles pads the 3rd seat by reusing
    // models[0] ('claude') round-robin, so 'claude' ends up assigned to TWO
    // agents and 'gemini' to one. Failing 'claude' fails both its agents,
    // leaving exactly gemini's single response valid.
    const { adapter } = createGapAdapter({ broadcast: { claude: 'THROW' } });
    const models = [model('claude'), model('gemini', 'google')];
    const orch = new Orchestrator(adapter, createRenderer(), models);

    const session = await orch.run('Design a scalable architecture with tradeoffs', { mode: 'debate' });

    expect(session.consensus).toBeUndefined();
    expect(session.stages.find(s => s.phase === 'consensus')?.status).toBe('skipped');
    expect(session.synthesis).toBe('Answer from gemini');
  });
});

describe('Orchestrator.run — truncated response notification', () => {
  it('surfaces a degradation event when a response is truncated, without dropping it', async () => {
    const { adapter } = createGapAdapter({ truncatedFor: ['claude'] });
    const models = [model('claude')];
    const renderer = createRenderer();
    const orch = new Orchestrator(adapter, renderer, models);

    const session = await orch.run('Hello', { mode: 'quick' });

    expect(session.status).toBe('completed');
    expect(renderer.onDegradation).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'broadcast', reason: expect.stringContaining('truncated') }),
    );
  });
});

describe('Orchestrator.run — pre-synthesis compression', () => {
  it('compresses long responses before synthesis when the combined length exceeds the threshold', async () => {
    // With self-review exclusion active (debate mode always designs >= 3
    // agents), each rater's own answer is imputed at the mean rank, which
    // structurally caps round-0 agreement well under the 0.6 cross-examine
    // stop threshold even for a perfectly consistent ranking. Rather than
    // fight that, keep BOTH broadcast and every cross-examine round long, so
    // whichever stage ends up "latest" when the (bounded) round loop exits
    // still exceeds the compression threshold.
    const longAnswer = (marker: string) => `${marker} `.repeat(4000); // ~12,000-20,000 chars each
    const { adapter } = createGapAdapter({
      broadcast: { claude: longAnswer('CLAUDE'), gemini: longAnswer('GEMINI'), gpt: longAnswer('GPT') },
      crossExamine: { claude: longAnswer('CLAUDE2'), gemini: longAnswer('GEMINI2'), gpt: longAnswer('GPT2') },
    });
    const models = [model('claude'), model('gemini', 'google'), model('gpt', 'openai')];
    const orch = new Orchestrator(adapter, createRenderer(), models);

    const session = await orch.run('Design a scalable architecture with tradeoffs', { mode: 'debate' });

    const compressionStage = session.stages.find(s => s.phase === 'pre_synthesis_compression');
    expect(compressionStage?.status).toBe('completed');

    // Compression annotates the LATEST completed broadcast/cross_examine stage
    // (whichever round the debate loop ended on), not necessarily the
    // original broadcast — the round loop may carry on for multiple rounds.
    const responseStages = session.stages.filter(
      s => (s.phase === 'broadcast' || s.phase === 'cross_examine') && s.status === 'completed',
    );
    const latestResponseStage = responseStages[responseStages.length - 1]!;
    expect(latestResponseStage.invocations.some(i => i.response_compressed !== undefined)).toBe(true);
  });

  it('uses the shared label_map (not self-exclusion) when only 2 answers survive broadcast', async () => {
    // 1 of 3 models fails broadcast -> exactly 2 valid answers -> self-review
    // exclusion is disabled (< 3), so the review stage records a single shared
    // label_map instead of per-reviewer maps. This exercises the label_map
    // branch of executePreSynthesisCompression's review-score lookup, as
    // opposed to the reviewer_label_maps fallback exercised by the test above.
    const longAnswer = (marker: string) => `${marker} `.repeat(4000);
    const { adapter } = createGapAdapter({
      broadcast: { claude: longAnswer('CLAUDE'), gemini: longAnswer('GEMINI'), gpt: 'THROW' },
      crossExamine: { claude: longAnswer('CLAUDE2'), gemini: longAnswer('GEMINI2') },
    });
    const models = [model('claude'), model('gemini', 'google'), model('gpt', 'openai')];
    const orch = new Orchestrator(adapter, createRenderer(), models);

    const session = await orch.run('Design a scalable architecture with tradeoffs', { mode: 'debate' });

    const reviewStage = session.stages.filter(s => s.phase === 'review' && s.status === 'completed').pop();
    expect(reviewStage?.label_map).toBeDefined();
    expect(reviewStage?.reviewer_label_maps).toBeUndefined();

    const compressionStage = session.stages.find(s => s.phase === 'pre_synthesis_compression');
    expect(compressionStage?.status).toBe('completed');
  });
});
