import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { createApp } from '../../src/server/app.js';
import { DebateManager } from '../../src/server/debate-manager.js';
import type { InvocationAdapter, InvocationResult, HealthStatus } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { Session } from '../../src/types/session.js';
import type { SessionStore } from '../../src/storage/session-store.js';

const PORT = 8787;
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` };

/** Mock adapter that answers each prompt kind so a debate completes fast. */
function createMockAdapter(): InvocationAdapter {
  const base = {
    elapsed_ms: 5,
    invocation_mode: 'api' as const,
    http_status: 200,
    token_usage: { input_tokens: 20, output_tokens: 40 },
    timed_out: false,
  };
  return {
    invoke: vi.fn().mockImplementation(async (_config: unknown, prompt: string) => {
      if (prompt.includes('multi-expert debate panel')) {
        return {
          ...base,
          response: JSON.stringify([
            { name: 'Analyst', icon: '🔍', description: 'analysis', system_prompt: 'You analyze.', assigned_model: 'claude' },
            { name: 'Engineer', icon: '⚙️', description: 'engineering', system_prompt: 'You build.', assigned_model: 'gemini' },
          ]),
        } satisfies InvocationResult;
      }
      if (prompt.includes('Chairman')) {
        return { ...base, response: 'Synthesized conclusion.' } satisfies InvocationResult;
      }
      return { ...base, response: 'Expert perspective on the question.' } satisfies InvocationResult;
    }),
    healthCheck: vi.fn().mockResolvedValue({
      level: 'healthy',
      message: 'OK',
      checked_at: new Date().toISOString(),
    } satisfies HealthStatus),
  };
}

function createModels(): ModelConfig[] {
  return [
    {
      name: 'claude', invocation: 'api', provider: 'anthropic', model: 'claude-test',
      timeout_seconds: 120, capabilities: ['general'], priority: 100, max_concurrent: 1,
      resource_weight: 1, enabled: true, streaming: true, api_key_env: 'ANTHROPIC_API_KEY',
    },
    {
      name: 'gemini', invocation: 'api', provider: 'google', model: 'gemini-test',
      timeout_seconds: 120, capabilities: ['general'], priority: 90, max_concurrent: 1,
      resource_weight: 1, enabled: true, streaming: true,
    },
  ];
}

function sampleSession(): Session {
  return {
    session_id: 'known', question: 'What is caching?', question_hash: 'h',
    mode: 'debate', resolved_mode: 'debate', status: 'completed',
    agents: [], stages: [],
    consensus: { agreement_score: 0.8, consensus_score: 0.7, dimension_scores: {}, model_diversity_factor: 0.9, raw_agreement: 0.8 },
    user_rating: 4, created_at: new Date().toISOString(),
  };
}

function makeApp(): { app: ReturnType<typeof createApp>; save: ReturnType<typeof vi.fn> } {
  const save = vi.fn(async () => {});
  const store = {
    saveSession: save,
    getSession: vi.fn(async (id: string) => (id === 'known' ? sampleSession() : null)),
    listSessions: vi.fn(async () => [sampleSession()]),
  } as unknown as SessionStore;

  const manager = new DebateManager({
    adapter: createMockAdapter(),
    models: createModels(),
    store,
    eventLogOptions: { ttlMs: 60_000 },
  });

  const app = createApp({
    manager,
    store,
    models: createModels(),
    defaultChairman: 'claude',
    port: PORT,
    webRoot: tmpdir(),
  });
  return { app, save };
}

describe('GET /api/models', () => {
  it('returns model metadata + mode enum, never credentials', async () => {
    const { app } = makeApp();
    const res = await app.request('http://x/api/models', { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      models: { name: string; invocation: string }[];
      modes: string[];
      defaultChairman?: string;
    };
    expect(body.models.map((m) => m.name)).toEqual(['claude', 'gemini']);
    expect(body.modes).toEqual(['quick', 'compare', 'debate', 'auto']);
    expect(body.defaultChairman).toBe('claude');
    expect(JSON.stringify(body)).not.toContain('api_key_env');
    expect(JSON.stringify(body)).not.toContain('timeout_seconds');
  });
});

describe('GET /api/sessions', () => {
  it('returns projected summaries', async () => {
    const { app } = makeApp();
    const res = await app.request('http://x/api/sessions', { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Record<string, unknown>[] };
    expect(body.sessions).toHaveLength(1);
    const s = body.sessions[0]!;
    expect(s.session_id).toBe('known');
    expect(s.consensus_score).toBe(0.7);
    expect(s.user_rating).toBe(4);
    // Projection: full stages/agents must not be present.
    expect(s.stages).toBeUndefined();
  });
});

describe('GET /api/sessions/:id', () => {
  it('returns 200 with the session when found', async () => {
    const { app } = makeApp();
    const res = await app.request('http://x/api/sessions/known', { headers: HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { session: Session };
    expect(body.session.session_id).toBe('known');
  });

  it('returns 404 when not found', async () => {
    const { app } = makeApp();
    const res = await app.request('http://x/api/sessions/missing', { headers: HEADERS });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/debates', () => {
  it('rejects an invalid body with 400', async () => {
    const { app } = makeApp();
    const res = await app.request('http://x/api/debates', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'debate' }), // missing question
    });
    expect(res.status).toBe(400);
  });

  it('returns 202 with a debateId', async () => {
    const { app } = makeApp();
    const res = await app.request('http://x/api/debates', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Redis vs Memcached?', mode: 'compare' }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { debateId: string };
    expect(typeof body.debateId).toBe('string');
    expect(body.debateId.length).toBeGreaterThan(0);
  });
});

describe('POST /api/debates — boundary inputs', () => {
  it('rejects an empty-string question with 400', async () => {
    const { app } = makeApp();
    const res = await app.request('http://x/api/debates', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ question: '', mode: 'debate' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an illegal mode enum value with 400', async () => {
    const { app } = makeApp();
    const res = await app.request('http://x/api/debates', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Redis vs Memcached?', mode: 'debug-mode' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a non-string mode value with 400', async () => {
    const { app } = makeApp();
    const res = await app.request('http://x/api/debates', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Redis vs Memcached?', mode: 123 }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed JSON body with 400', async () => {
    const { app } = makeApp();
    const res = await app.request('http://x/api/debates', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: '{not valid json',
    });
    expect(res.status).toBe(400);
  });

  it('rejects a question exceeding the 8k cost-guard upper bound with 400', async () => {
    const { app } = makeApp();
    const longQuestion = 'x'.repeat(100_000);
    const res = await app.request('http://x/api/debates', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ question: longQuestion, mode: 'quick' }),
    });
    expect(res.status).toBe(400);
  });

  it('accepts a question at exactly the 8k boundary', async () => {
    const { app } = makeApp();
    const res = await app.request('http://x/api/debates', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'x'.repeat(8_000), mode: 'quick' }),
    });
    expect(res.status).toBe(202);
  });
});

describe('SSE /api/debates/:id/events', () => {
  it('returns 404 for an unknown debateId', async () => {
    const { app } = makeApp();
    const res = await app.request('http://x/api/debates/does-not-exist/events', { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  it('returns 404 for a debateId containing URL-encoded special characters', async () => {
    const { app } = makeApp();
    const res = await app.request('http://x/api/debates/%2e%2e%2fetc%2fpasswd/events', { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  it('returns 404 (not a crash) for an extremely long debateId', async () => {
    const { app } = makeApp();
    const res = await app.request(`http://x/api/debates/${'a'.repeat(4000)}/events`, { headers: HEADERS });
    expect(res.status).toBe(404);
  });

  it('streams the full event sequence through the terminal result', async () => {
    const { app, save } = makeApp();
    const post = await app.request('http://x/api/debates', {
      method: 'POST',
      headers: { ...HEADERS, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Redis vs Memcached?', mode: 'compare' }),
    });
    const { debateId } = (await post.json()) as { debateId: string };

    const res = await app.request(`http://x/api/debates/${debateId}/events`, { headers: HEADERS });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    // First event is the server-injected debate_start; stream ends at result.
    expect(text).toContain('event: debate_start');
    expect(text).toContain('event: phase');
    expect(text).toContain('event: result');
    // Terminal result carries the persisted session id for history navigation.
    const resultIdx = text.indexOf('event: result');
    expect(resultIdx).toBeGreaterThan(text.indexOf('event: debate_start'));

    // Debate was persisted (default: store on).
    expect(save).toHaveBeenCalledOnce();
  });
});
