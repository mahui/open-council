import { describe, it, expect, vi } from 'vitest';
import { Orchestrator } from '../../src/core/orchestrator.js';
import type { InvocationAdapter, InvocationResult, HealthStatus } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { Renderer } from '../../src/ui/renderer.js';
import type { Stage } from '../../src/types/session.js';

/**
 * Integration tests for work item #3 (self-review exclusion). Each reviewer must
 * evaluate an anonymized subset that omits its OWN answer when N ≥ 3, and fall
 * back to the full set (self-review kept) when only 2 answers remain.
 */

function model(name: string, provider: 'anthropic' | 'openai' | 'google'): ModelConfig {
  return {
    name, invocation: 'api', provider, model: `${provider}-model`,
    timeout_seconds: 120, capabilities: ['general'], priority: 100,
    max_concurrent: 1, resource_weight: 1, enabled: true, streaming: true,
  };
}

function createRenderer(): Renderer {
  return {
    onPhaseStart: vi.fn(), onAgentStart: vi.fn(), onAgentProgress: vi.fn(),
    onAgentComplete: vi.fn(), onConsensus: vi.fn(), onDegradation: vi.fn(),
    renderResult: vi.fn(),
  };
}

interface Recorded { name: string; prompt: string }

/**
 * Adapter with a 1:1 model↔agent mapping (three distinct models) so a reviewer's
 * own answer is identifiable by a marker string. `failBroadcastFor` forces one
 * model's broadcast to fail, dropping the debate to N = 2 valid answers.
 */
function createAdapter(recorded: Recorded[], failBroadcastFor?: string): InvocationAdapter {
  const marker = (name: string): string => `ANSWER_${name.toUpperCase()}_UNIQUE`;
  return {
    invoke: vi.fn().mockImplementation(async (config: ModelConfig, prompt: string) => {
      recorded.push({ name: config.name, prompt });
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
            { name: 'Critic', icon: '🎯', description: 'c', system_prompt: 'You challenge.', assigned_model: 'gpt' },
          ]),
        } satisfies InvocationResult;
      }

      // Peer review → score by the labels actually present in THIS reviewer's prompt.
      if (prompt.includes('evaluating anonymous responses')) {
        const labels = [...prompt.matchAll(/--- Response (\w+) ---/g)].map(m => m[1]!);
        return {
          ...base,
          response: JSON.stringify({
            reviews: labels.map((label, i) => {
              const overall = 9 - i;
              return { label, scores: { accuracy: overall, completeness: overall, practicality: overall, insight: overall, overall }, strengths: 'ok', weaknesses: 'minor', ranking: i + 1 };
            }),
          }),
        } satisfies InvocationResult;
      }

      if (prompt.includes('Chairman')) {
        return { ...base, response: 'Synthesis.' } satisfies InvocationResult;
      }

      // Broadcast / cross-examine: emit a per-model marker; optionally fail one model.
      if (failBroadcastFor && config.name === failBroadcastFor) {
        throw new Error('broadcast down');
      }
      return { ...base, response: `${marker(config.name)} expert analysis.` } satisfies InvocationResult;
    }),
    healthCheck: vi.fn().mockResolvedValue({ level: 'healthy', message: 'OK', checked_at: new Date().toISOString() } satisfies HealthStatus),
  };
}

function latestReviewStage(stages: Stage[]): Stage | undefined {
  const reviews = stages.filter(s => s.phase === 'review' && s.status === 'completed');
  return reviews[reviews.length - 1];
}

const MODELS = (): ModelConfig[] => [model('claude', 'anthropic'), model('gemini', 'google'), model('gpt', 'openai')];

describe('self-review exclusion (N ≥ 3)', () => {
  it('records a per-reviewer label map that omits each reviewer’s own answer', async () => {
    const recorded: Recorded[] = [];
    const orch = new Orchestrator(createAdapter(recorded), createRenderer(), MODELS());
    const session = await orch.run('Design a scalable architecture with tradeoffs', { mode: 'debate' });

    const reviewStage = latestReviewStage(session.stages);
    expect(reviewStage?.reviewer_label_maps).toBeDefined();
    // Full-set label_map must NOT be used under exclusion.
    expect(reviewStage?.label_map).toBeUndefined();

    const validBroadcast = session.stages
      .find(s => s.phase === 'broadcast')!
      .invocations.filter(i => !i.timed_out && i.response_raw);
    const validIds = new Set(validBroadcast.map(i => i.agent_id));
    expect(validIds.size).toBe(3);

    const maps = reviewStage!.reviewer_label_maps!;
    for (const agent of session.agents) {
      if (!validIds.has(agent.agent_id)) continue;
      const map = maps[agent.agent_id];
      expect(map).toBeDefined();
      const reviewedIds = Object.values(map!);
      // Each reviewer sees exactly N-1 answers …
      expect(reviewedIds).toHaveLength(2);
      // … and never its own.
      expect(reviewedIds).not.toContain(agent.agent_id);
    }
  });

  it('never shows a reviewer its own answer content in the review prompt', async () => {
    const recorded: Recorded[] = [];
    const orch = new Orchestrator(createAdapter(recorded), createRenderer(), MODELS());
    await orch.run('Design a scalable architecture with tradeoffs', { mode: 'debate' });

    // With a 1:1 model↔agent mapping the reviewer's own answer marker is ANSWER_<MODEL>_UNIQUE.
    for (const name of ['claude', 'gemini', 'gpt']) {
      const reviewPrompts = recorded.filter(r => r.name === name && r.prompt.includes('evaluating anonymous responses'));
      expect(reviewPrompts.length).toBeGreaterThan(0);
      const ownMarker = `ANSWER_${name.toUpperCase()}_UNIQUE`;
      for (const { prompt } of reviewPrompts) {
        expect(prompt).not.toContain(ownMarker);
      }
    }
  });

  it('still computes a valid consensus attributed by reviewed answer', async () => {
    const recorded: Recorded[] = [];
    const orch = new Orchestrator(createAdapter(recorded), createRenderer(), MODELS());
    const session = await orch.run('Design a scalable architecture with tradeoffs', { mode: 'debate' });

    expect(session.consensus).toBeDefined();
    expect(session.consensus!.agreement_score).toBeGreaterThanOrEqual(0);
    expect(session.consensus!.agreement_score).toBeLessThanOrEqual(1);
    expect(session.consensus!.dimension_scores).toHaveProperty('accuracy');
  });
});

describe('self-review exclusion fallback (N = 2)', () => {
  it('keeps the full-set label_map and skips per-reviewer maps when only 2 answers remain', async () => {
    const recorded: Recorded[] = [];
    // gpt's broadcast fails → 2 valid answers → self-exclusion disabled.
    const orch = new Orchestrator(createAdapter(recorded, 'gpt'), createRenderer(), MODELS());
    const session = await orch.run('Design a scalable architecture with tradeoffs', { mode: 'debate' });

    const validBroadcast = session.stages
      .find(s => s.phase === 'broadcast')!
      .invocations.filter(i => !i.timed_out && i.response_raw);
    expect(validBroadcast).toHaveLength(2);

    const reviewStage = latestReviewStage(session.stages);
    expect(reviewStage).toBeDefined();
    // Full-set path: label_map present, no per-reviewer maps.
    expect(reviewStage!.label_map).toBeDefined();
    expect(Object.keys(reviewStage!.label_map!)).toHaveLength(2);
    expect(reviewStage!.reviewer_label_maps).toBeUndefined();
  });
});
