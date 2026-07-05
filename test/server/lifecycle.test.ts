import { describe, it, expect, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { serve } from '@hono/node-server';
import { createApp } from '../../src/server/app.js';
import { makeRuntime, makeConfigDeps } from './runtime-helpers.js';
import { DebateManager } from '../../src/server/debate-manager.js';
import type { InvocationAdapter, InvocationResult, HealthStatus } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { SessionStore } from '../../src/storage/session-store.js';

/** Mock adapter that answers each prompt kind so a debate completes fast (mirrors routes.test.ts). */
function createMockAdapter(options: { hang?: boolean } = {}): InvocationAdapter {
  const base = {
    elapsed_ms: 5,
    invocation_mode: 'api' as const,
    http_status: 200,
    token_usage: { input_tokens: 20, output_tokens: 40 },
    timed_out: false,
  };
  return {
    invoke: vi.fn().mockImplementation(async (_config: unknown, prompt: string) => {
      // Never resolves — keeps any debate that reaches broadcast perpetually
      // in-flight, so its SSE connection never reaches a terminal event.
      if (options.hang) return new Promise<InvocationResult>(() => {});
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

function createMockStore(): SessionStore {
  return {
    saveSession: vi.fn(async () => {}),
    getSession: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
  } as unknown as SessionStore;
}

function makeApp(port: number, opts: { adapter?: InvocationAdapter; ttlMs?: number } = {}) {
  const store = createMockStore();
  const runtime = makeRuntime(opts.adapter ?? createMockAdapter(), createModels());
  const manager = new DebateManager({
    runtime,
    store,
    eventLogOptions: { ttlMs: opts.ttlMs },
  });
  const app = createApp({
    manager, store, runtime, ...makeConfigDeps(), port, webRoot: tmpdir(),
  });
  return { app, manager, store };
}

describe('EventLog TTL 后订阅', () => {
  it('辩论完成 5 分钟后（fake timers）订阅 → 404（合理终态），而非悬挂', async () => {
    vi.useFakeTimers();
    try {
      const port = 8820;
      // No ttlMs override — exercises EventLog's real 5-minute default.
      const { app } = makeApp(port);
      const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };

      const post = await app.request('http://x/api/debates', {
        method: 'POST', headers,
        body: JSON.stringify({ question: 'What is caching?', mode: 'quick' }),
      });
      const { debateId } = (await post.json()) as { debateId: string };

      // Drain the stream once so we know the debate reached `result`
      // (and therefore `markTerminal()` has already fired, starting the TTL clock).
      const res1 = await app.request(`http://x/api/debates/${debateId}/events`, { headers });
      const text1 = await res1.text();
      expect(text1).toContain('event: result');

      // Immediately after completion the buffer is still retained (within TTL).
      const resSoon = await app.request(`http://x/api/debates/${debateId}/events`, { headers });
      expect(resSoon.status).toBe(200);
      await resSoon.text();

      // Advance the fake clock past the 5-minute TTL.
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);

      // A late subscriber gets a clean 404 — not a hang, not a crash.
      const resLate = await app.request(`http://x/api/debates/${debateId}/events`, { headers });
      expect(resLate.status).toBe(404);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('生命周期：辩论进行中关闭 server', () => {
  it('活跃 SSE 连接期间 close() 悬挂；客户端断开后才完成回调（印证 serve.ts 2s 安全网存在的前提）', async () => {
    const port = 18899;
    const adapter = createMockAdapter({ hang: true }); // invoke() never resolves — debate stays in-flight
    const { app } = makeApp(port, { adapter, ttlMs: 60_000 });

    const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', resolve));

    try {
      const origin = `http://127.0.0.1:${port}`;
      const headers = { host: `127.0.0.1:${port}`, origin, 'content-type': 'application/json' };

      const post = await fetch(`${origin}/api/debates`, {
        method: 'POST', headers,
        body: JSON.stringify({ question: 'Will this ever finish?', mode: 'quick' }),
      });
      expect(post.status).toBe(202);
      const { debateId } = (await post.json()) as { debateId: string };

      const controller = new AbortController();
      const sseRes = await fetch(`${origin}/api/debates/${debateId}/events`, { headers, signal: controller.signal });
      expect(sseRes.status).toBe(200);

      // Prove the connection is actually live before we start closing things.
      const reader = sseRes.body!.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);

      let closed = false;
      server.close(() => {
        closed = true;
      });

      // The SSE connection is still open, so close() must not have completed
      // yet — this is exactly why serve.ts installs a 2s safety-net exit timer.
      await new Promise((r) => setTimeout(r, 200));
      expect(closed).toBe(false);

      // Simulate the client disconnecting (what a real page unload/refresh does).
      controller.abort();
      await reader.cancel().catch(() => {});

      // Now that the only open connection is gone, close() can finish promptly.
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 3000, interval: 20 });
    } finally {
      // Defensive cleanup regardless of where an assertion above may have failed.
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
      });
    }
  }, 10_000);
});
