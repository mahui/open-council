import { describe, it, expect } from 'vitest';
import { EventLog } from '../../src/server/event-log.js';
import { WebRenderer } from '../../src/server/web-renderer.js';
import type { DebateEvent } from '../../src/server/protocol.js';
import type { Agent, Session, ConsensusResult, DegradationEvent } from '../../src/types/session.js';
import type { InvocationResult } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';

function makeModel(): ModelConfig {
  return {
    name: 'claude',
    protocol: 'anthropic',
    provider: 'anthropic',
    model: 'claude-test',
    timeout_seconds: 120,
    capabilities: ['general'],
    priority: 100,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: true,
    api_key_env: 'ANTHROPIC_API_KEY', // must NOT leak into the DTO
  };
}

function makeAgent(): Agent {
  return {
    agent_id: 'agent-1',
    config: makeModel(),
    role: '🔬 Researcher',
    role_description: 'Investigates the evidence',
    system_prompt: 'You research.',
    is_chairman: false,
    is_devil_advocate: true,
  };
}

function makeResult(): InvocationResult {
  return {
    response: 'A thorough answer.',
    elapsed_ms: 1234,
    invocation_mode: 'api',
    stderr: 'diagnostic noise that must be dropped',
    token_usage: { input_tokens: 10, output_tokens: 20 },
    timed_out: false,
    truncated: false,
  };
}

function makeConsensus(): ConsensusResult {
  return {
    agreement_score: 0.8,
    consensus_score: 0.72,
    dimension_scores: {},
    model_diversity_factor: 0.9,
    raw_agreement: 0.8,
  };
}

function makeSession(): Session {
  return {
    session_id: 'sess-1',
    question: 'Q?',
    question_hash: 'h',
    mode: 'debate',
    resolved_mode: 'debate',
    status: 'completed',
    agents: [makeAgent()],
    stages: [],
    created_at: new Date().toISOString(),
  };
}

describe('WebRenderer', () => {
  it('maps all 7 Renderer callbacks to the corresponding wire events', () => {
    const log = new EventLog();
    const events: DebateEvent[] = [];
    log.subscribe((event) => events.push(event));

    const renderer = new WebRenderer(log);
    renderer.onPhaseStart('broadcast', 1, 3);
    renderer.onAgentStart(makeAgent());
    renderer.onAgentProgress(makeAgent(), 'chunk');
    renderer.onAgentComplete(makeAgent(), makeResult());
    renderer.onConsensus(makeConsensus());
    renderer.onDegradation({ phase: 'review', reason: 'timeout', impact: 'fewer reviews' } satisfies DegradationEvent);
    renderer.renderResult(makeSession());

    expect(events.map((e) => e.type)).toEqual([
      'phase',
      'agent_start',
      'agent_progress',
      'agent_complete',
      'consensus',
      'degradation',
      'result',
    ]);
  });

  it('projects Agent onto a minimal DTO without leaking ModelConfig', () => {
    const log = new EventLog();
    const events: DebateEvent[] = [];
    log.subscribe((event) => events.push(event));

    new WebRenderer(log).onAgentStart(makeAgent());

    const evt = events[0];
    expect(evt?.type).toBe('agent_start');
    if (evt?.type !== 'agent_start') throw new Error('unexpected');
    expect(evt.data.agent).toEqual({
      agentId: 'agent-1',
      role: '🔬 Researcher',
      roleDescription: 'Investigates the evidence',
      modelName: 'claude',
      isChairman: false,
      isDevilAdvocate: true,
    });
    // No credential/config field surface in the serialized payload.
    expect(JSON.stringify(evt.data)).not.toContain('ANTHROPIC_API_KEY');
    expect(JSON.stringify(evt.data)).not.toContain('timeout_seconds');
  });

  it('projects InvocationResult onto a minimal DTO, dropping diagnostics', () => {
    const log = new EventLog();
    const events: DebateEvent[] = [];
    log.subscribe((event) => events.push(event));

    new WebRenderer(log).onAgentComplete(makeAgent(), makeResult());

    const evt = events[0];
    if (evt?.type !== 'agent_complete') throw new Error('unexpected');
    expect(evt.data.result).toEqual({
      response: 'A thorough answer.',
      elapsedMs: 1234,
      invocationMode: 'api',
      timedOut: false,
      truncated: false,
      tokenUsage: { inputTokens: 10, outputTokens: 20 },
    });
    expect(JSON.stringify(evt.data.result)).not.toContain('diagnostic noise');
  });
});
