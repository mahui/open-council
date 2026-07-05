import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { createApp } from '../../src/server/app.js';
import { DebateManager } from '../../src/server/debate-manager.js';
import type { InvocationAdapter, InvocationResult, HealthStatus, OnChunk } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { SessionStore } from '../../src/storage/session-store.js';
import type { DebateEvent, AgentCompletePayload } from '../../src/server/protocol.js';

/**
 * Mock adapter that answers each prompt kind so a debate completes
 * deterministically, optionally streaming extra progress chunks first
 * (used by the eviction test below to inflate the EventLog's byte budget).
 */
function createMockAdapter(options: { progressChunks?: string[]; onChunkSeen?: (chunk: string) => void } = {}): InvocationAdapter {
  const base = {
    elapsed_ms: 5,
    invocation_mode: 'api' as const,
    http_status: 200,
    token_usage: { input_tokens: 20, output_tokens: 40 },
    timed_out: false,
  };
  return {
    invoke: vi.fn().mockImplementation(async (_config: unknown, prompt: string, onChunk?: OnChunk) => {
      if (options.progressChunks) {
        for (const chunk of options.progressChunks) {
          onChunk?.(chunk);
          options.onChunkSeen?.(chunk);
        }
      }
      if (prompt.includes('multi-expert debate panel')) {
        return {
          ...base,
          response: JSON.stringify([
            { name: 'Analyst', icon: '🔍', description: 'analysis', system_prompt: 'You analyze.', assigned_model: 'claude' },
            { name: 'Engineer', icon: '⚙️', description: 'engineering', system_prompt: 'You build.', assigned_model: 'gemini' },
          ]),
        } satisfies InvocationResult;
      }
      if (prompt.includes('evaluating anonymous responses')) {
        const labels = [...prompt.matchAll(/--- Response (\w+) ---/g)].map((m) => m[1]!);
        return {
          ...base,
          response: JSON.stringify({
            reviews: labels.map((label, i) => {
              const overall = 9 - i;
              return {
                label,
                scores: { accuracy: overall, completeness: overall, practicality: overall, insight: overall, overall },
                strengths: 'Strong', weaknesses: 'Minor', ranking: i + 1,
              };
            }),
          }),
        } satisfies InvocationResult;
      }
      if (prompt.includes('Chairman')) {
        return { ...base, response: 'Synthesized conclusion combining all expert perspectives.' } satisfies InvocationResult;
      }
      return {
        ...base,
        response: 'Expert perspective on the question, with enough detail to be a plausible full answer.',
      } satisfies InvocationResult;
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

function makeApp(
  port: number,
  opts: { adapter?: InvocationAdapter; eventLogOptions?: { maxBytes?: number; ttlMs?: number } } = {},
): { app: ReturnType<typeof createApp>; manager: DebateManager } {
  const store = {
    saveSession: vi.fn(async () => {}),
    getSession: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
  } as unknown as SessionStore;

  const manager = new DebateManager({
    adapter: opts.adapter ?? createMockAdapter(),
    models: createModels(),
    store,
    eventLogOptions: opts.eventLogOptions ?? { ttlMs: 60_000 },
  });

  const app = createApp({
    manager, store, models: createModels(), defaultChairman: 'claude', port, webRoot: tmpdir(),
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

/**
 * Read from an SSE response until at least `minFrames` complete frames have
 * been parsed, then cancel the reader — simulating an abrupt client
 * disconnect partway through the stream.
 */
async function readFramesThenDisconnect(res: Response, minFrames: number): Promise<ParsedFrame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const frames: ParsedFrame[] = [];
  while (frames.length < minFrames) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    const parts = buffered.split('\n\n');
    buffered = parts.pop() ?? '';
    for (const part of parts) {
      frames.push(...parseSSE(`${part}\n\n`));
    }
  }
  await reader.cancel();
  return frames;
}

describe('断线重连 — Last-Event-ID 回放语义', () => {
  it('连接中途断开后重连：精确收到断开期间产生的缺失事件，不重复不遗漏', async () => {
    const port = 8810;
    const { app } = makeApp(port);
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };

    const post = await app.request('http://x/api/debates', {
      method: 'POST', headers,
      body: JSON.stringify({ question: 'Redis vs Memcached?', mode: 'compare' }),
    });
    const { debateId } = (await post.json()) as { debateId: string };

    // First connection: read a couple of frames, then simulate an abrupt disconnect.
    const res1 = await app.request(`http://x/api/debates/${debateId}/events`, { headers });
    const framesBeforeDisconnect = await readFramesThenDisconnect(res1, 2);
    expect(framesBeforeDisconnect.length).toBeGreaterThanOrEqual(2);
    const lastSeenId = framesBeforeDisconnect.at(-1)!.id!;

    // Reconnect with Last-Event-ID set to the last frame we actually consumed.
    const res2 = await app.request(`http://x/api/debates/${debateId}/events`, {
      headers: { ...headers, 'last-event-id': String(lastSeenId) },
    });
    expect(res2.status).toBe(200);
    const framesAfterReconnect = parseSSE(await res2.text());

    // No duplicates: nothing already consumed before the disconnect is resent.
    for (const frame of framesAfterReconnect) {
      expect(frame.id!).toBeGreaterThan(lastSeenId);
    }

    // No gaps: merging both connections reconstructs a full, contiguous 1..N id run.
    const allIds = [...framesBeforeDisconnect, ...framesAfterReconnect].map((f) => f.id!).sort((a, b) => a - b);
    for (let i = 0; i < allIds.length; i++) {
      expect(allIds[i]).toBe(i + 1);
    }

    // The reconnected stream still runs through to the terminal result.
    expect(framesAfterReconnect.at(-1)?.event).toBe('result');
  });

  it('agent_progress 在缓冲区超限后被驱逐，重连仍能收到 agent_complete 权威全文，不缺关键帧', async () => {
    const port = 8811;
    const chunksSeen: string[] = [];
    const adapter = createMockAdapter({
      // Several sizable chunks per invocation so the tiny byte budget below evicts early ones.
      progressChunks: ['chunk-one-'.repeat(10), 'chunk-two-'.repeat(10), 'chunk-three-'.repeat(10)],
      onChunkSeen: (c) => chunksSeen.push(c),
    });
    const { app, manager } = makeApp(port, { adapter, eventLogOptions: { maxBytes: 250, ttlMs: 60_000 } });
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };

    const post = await app.request('http://x/api/debates', {
      method: 'POST', headers,
      body: JSON.stringify({ question: 'Design a scalable architecture with tradeoffs', mode: 'debate' }),
    });
    const { debateId } = (await post.json()) as { debateId: string };

    // Connect early, consume a couple of frames, then disconnect before the debate finishes.
    const res1 = await app.request(`http://x/api/debates/${debateId}/events`, { headers });
    const framesBeforeDisconnect = await readFramesThenDisconnect(res1, 2);
    const lastSeenId = framesBeforeDisconnect.at(-1)!.id!;

    // Reconnect and drain to completion.
    const res2 = await app.request(`http://x/api/debates/${debateId}/events`, {
      headers: { ...headers, 'last-event-id': String(lastSeenId) },
    });
    const framesAfterReconnect = parseSSE(await res2.text());
    expect(framesAfterReconnect.at(-1)?.event).toBe('result');

    // Sanity: the mock adapter really did stream enough progress to be able to exceed the budget.
    expect(chunksSeen.length).toBeGreaterThan(3);

    // Eviction actually happened: the final buffer holds fewer agent_progress
    // entries than chunks were pushed — some were dropped for being over budget.
    const finalLog = manager.getLog(debateId)!;
    const finalEvents: { id: number; event: DebateEvent }[] = [];
    finalLog.replayFrom(0, (event, id) => finalEvents.push({ id, event }));
    const remainingProgress = finalEvents.filter((f) => f.event.type === 'agent_progress');
    expect(remainingProgress.length).toBeLessThan(chunksSeen.length);

    // But agent_complete — the authoritative full text — always survives
    // eviction, so the reconnecting client never loses the substantive answer.
    const completeFrames = [...framesBeforeDisconnect, ...framesAfterReconnect].filter((f) => f.event === 'agent_complete');
    expect(completeFrames.length).toBeGreaterThan(0);
    for (const f of completeFrames) {
      const payload = frameData<AgentCompletePayload>(f);
      expect(payload.result.response.length).toBeGreaterThan(0);
    }

    // No duplicate ids across the two connections.
    const seenIds = new Set<number>();
    for (const f of [...framesBeforeDisconnect, ...framesAfterReconnect]) {
      expect(seenIds.has(f.id!)).toBe(false);
      seenIds.add(f.id!);
    }
  });
});
