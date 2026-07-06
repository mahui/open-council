import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { createApp } from '../../src/server/app.js';
import { DebateManager } from '../../src/server/debate-manager.js';
import { makeRuntime, makeConfigDeps } from './runtime-helpers.js';
import type { InvocationAdapter, InvocationResult, HealthStatus } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { SessionStore } from '../../src/storage/session-store.js';
import type { DebateStartPayload, ResultPayload } from '../../src/server/protocol.js';

const PORT = 8801;
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, 'content-type': 'application/json' };

/** Mock adapter that answers each prompt kind so a debate completes fast (mirrors routes.test.ts). */
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
      name: 'claude', protocol: 'anthropic', provider: 'anthropic', model: 'claude-test',
      timeout_seconds: 120, capabilities: ['general'], priority: 100, max_concurrent: 1,
      resource_weight: 1, enabled: true, streaming: true, api_key_env: 'ANTHROPIC_API_KEY',
    },
    {
      name: 'gemini', protocol: 'openai', provider: 'google', model: 'gemini-test',
      timeout_seconds: 120, capabilities: ['general'], priority: 90, max_concurrent: 1,
      resource_weight: 1, enabled: true, streaming: true,
    },
  ];
}

function makeApp(port: number): { app: ReturnType<typeof createApp>; manager: DebateManager } {
  const store = {
    saveSession: vi.fn(async () => {}),
    getSession: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
  } as unknown as SessionStore;

  const runtime = makeRuntime(createMockAdapter(), createModels());
  const manager = new DebateManager({
    runtime,
    store,
    eventLogOptions: { ttlMs: 60_000 },
  });

  const app = createApp({
    manager, store, runtime, ...makeConfigDeps(), port, webRoot: tmpdir(),
  });
  return { app, manager };
}

interface ParsedFrame {
  id?: number;
  event?: string;
  data: string;
}

/** Parse raw SSE wire text into structured frames; heartbeat comments (`:hb`) are skipped. */
function parseSSE(text: string): ParsedFrame[] {
  return text
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0 && !chunk.startsWith(':'))
    .map((chunk) => {
      let event: string | undefined;
      let id: number | undefined;
      const dataLines: string[] = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice('event: '.length);
        else if (line.startsWith('id: ')) id = Number(line.slice('id: '.length));
        else if (line.startsWith('data: ')) dataLines.push(line.slice('data: '.length));
      }
      return { id, event, data: dataLines.join('\n') };
    });
}

function frameData<T>(frame: ParsedFrame): T {
  return JSON.parse(frame.data) as T;
}

describe('并发多场辩论 — SSE 事件按 debateId 隔离', () => {
  it('两场并发辩论互不串台：各自事件序列独立编号（debate_start 恒为 id 1）且内容不交叉', async () => {
    const { app } = makeApp(PORT);

    async function startDebate(question: string): Promise<string> {
      const res = await app.request('http://x/api/debates', {
        method: 'POST',
        headers: HEADERS,
        body: JSON.stringify({ question, mode: 'compare' }),
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { debateId: string };
      return body.debateId;
    }

    const [idA, idB] = await Promise.all([
      startDebate('Redis vs Memcached for session storage?'),
      startDebate('Kubernetes vs Nomad for orchestration?'),
    ]);
    expect(idA).not.toBe(idB);

    // Fetch both live streams concurrently — a shared/leaky EventLog would let
    // one debate's events bleed into the other's stream.
    const [resA, resB] = await Promise.all([
      app.request(`http://x/api/debates/${idA}/events`, { headers: HEADERS }),
      app.request(`http://x/api/debates/${idB}/events`, { headers: HEADERS }),
    ]);
    const [textA, textB] = await Promise.all([resA.text(), resB.text()]);
    const framesA = parseSSE(textA);
    const framesB = parseSSE(textB);

    // Independent per-debate id sequence: each EventLog starts its own counter at 1.
    expect(framesA[0]?.event).toBe('debate_start');
    expect(framesA[0]?.id).toBe(1);
    expect(framesB[0]?.event).toBe('debate_start');
    expect(framesB[0]?.id).toBe(1);

    const startA = frameData<DebateStartPayload>(framesA[0]!);
    const startB = frameData<DebateStartPayload>(framesB[0]!);
    expect(startA.debateId).toBe(idA);
    expect(startB.debateId).toBe(idB);

    // No cross-talk: each stream only ever mentions its own debateId / question.
    expect(textA).not.toContain(idB);
    expect(textB).not.toContain(idA);
    expect(textA).toContain('Redis vs Memcached');
    expect(textA).not.toContain('Kubernetes vs Nomad');
    expect(textB).toContain('Kubernetes vs Nomad');
    expect(textB).not.toContain('Redis vs Memcached');

    // Both reach their own terminal result, carrying the matching session question.
    expect(framesA.at(-1)?.event).toBe('result');
    expect(framesB.at(-1)?.event).toBe('result');
    const resultA = frameData<ResultPayload>(framesA.at(-1)!);
    const resultB = frameData<ResultPayload>(framesB.at(-1)!);
    expect(resultA.session.question).toContain('Redis vs Memcached');
    expect(resultB.session.question).toContain('Kubernetes vs Nomad');
  });

  it('DebateManager 为每场辩论维护独立的 EventLog 实例（非共享单槽位）', async () => {
    const { app, manager } = makeApp(PORT + 1);
    const headers = { host: `127.0.0.1:${PORT + 1}`, origin: `http://127.0.0.1:${PORT + 1}`, 'content-type': 'application/json' };

    const post = (q: string) =>
      app.request('http://x/api/debates', {
        method: 'POST',
        headers,
        body: JSON.stringify({ question: q, mode: 'quick' }),
      });

    const [ra, rb] = await Promise.all([post('First independent debate'), post('Second independent debate')]);
    const { debateId: idA } = (await ra.json()) as { debateId: string };
    const { debateId: idB } = (await rb.json()) as { debateId: string };

    const logA = manager.getLog(idA);
    const logB = manager.getLog(idB);
    expect(logA).toBeDefined();
    expect(logB).toBeDefined();
    expect(logA).not.toBe(logB);

    // Draining one stream to completion must not affect the other's independent state.
    const resA = await app.request(`http://x/api/debates/${idA}/events`, { headers });
    await resA.text();
    expect(logA!.terminal).toBe(true);

    const resB = await app.request(`http://x/api/debates/${idB}/events`, { headers });
    await resB.text();
    expect(logB!.terminal).toBe(true);
  });
});
