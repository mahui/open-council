/**
 * End-to-end integration smoke for `council serve` (task #31 Step 2.5).
 * Boots a REAL server (mock adapter + temp SessionStore) and exercises all five
 * routes + the SSE stream, asserting the front-end↔server wire contract.
 * Run: npx tsx scripts/serve-smoke.mts
 */
import { serve } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createApp } from '../src/server/app.js';
import { DebateManager } from '../src/server/debate-manager.js';
import { RuntimeConfig, buildSnapshot } from '../src/server/runtime-config.js';
import { SessionStore } from '../src/storage/session-store.js';
import { ConfigLoader } from '../src/config/loader.js';
import { CredentialManager } from '../src/providers/credentials/discovery.js';
import { assembleConfig } from '../src/config/assemble-council.js';
import { ModelConfigSchema } from '../src/config/schema.js';
import type { InvocationAdapter, InvocationResult, HealthStatus, OnChunk } from '../src/types/provider.js';
import type { ModelConfig } from '../src/types/config.js';

const PORT = 3799;
const ORIGIN = `http://localhost:${PORT}`;
const HDRS = { Host: `localhost:${PORT}`, Origin: ORIGIN };

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  process.stdout.write(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}\n`);
  if (!cond) failures++;
}

// Mock adapter: streams a couple chunks, returns canned response.
const mockAdapter: InvocationAdapter = {
  async invoke(config: ModelConfig, _prompt: string, onChunk?: OnChunk): Promise<InvocationResult> {
    onChunk?.('Thinking… ');
    onChunk?.('done.');
    return {
      response: `Answer from ${config.name}. I agree with the others. Final: yes. Score: 9/10.`,
      elapsed_ms: 5,
      invocation_mode: 'api',
      timed_out: false,
      token_usage: { input_tokens: 10, output_tokens: 20 },
    };
  },
  async healthCheck(): Promise<HealthStatus> {
    return { level: 'healthy', message: 'ok', checked_at: new Date().toISOString() };
  },
};

// Fully-parsed configs so the real Orchestrator has every default it needs.
const models: ModelConfig[] = ['mock-a', 'mock-b', 'mock-c'].map((name, i) =>
  ModelConfigSchema.parse({
    name,
    provider: ['anthropic', 'openai', 'google'][i],
    invocation: 'api',
    capabilities: ['reasoning'],
  }),
);

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'oc-smoke-'));
  const store = new SessionStore(join(dir, 'sessions'));

  // Post-#40 wiring: models/chairman/adapter live behind a RuntimeConfig snapshot
  // that DebateManager + routes read at request time. Seed a temp config dir so
  // buildSnapshot resolves the enabled set + default chairman from on-disk truth.
  const loader = new ConfigLoader(dir);
  for (const m of models) loader.saveModelConfig(m);
  loader.saveCouncilConfig(
    assembleConfig({
      generalOverride: { default_mode: 'auto', default_chairman: 'mock-a', min_agents: 2, max_agents: 5 },
      prefer: models.map((m) => m.name),
      chairman: 'mock-a',
      base: null,
    }),
  );
  const credentialManager = new CredentialManager();
  const runtime = new RuntimeConfig(buildSnapshot({ loader, credentialManager, adapter: mockAdapter }));
  const manager = new DebateManager({ runtime, store });
  const webRoot = join(import.meta.dirname, '..', 'web');
  const app = createApp({ manager, store, runtime, loader, credentialManager, port: PORT, webRoot });
  const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
  await new Promise((r) => setTimeout(r, 300));

  try {
    // 1. GET / → index.html
    const root = await fetch(`${ORIGIN}/`, { headers: HDRS });
    const rootBody = await root.text();
    check('GET / serves index.html', root.status === 200 && rootBody.includes('<!'), `status=${root.status}`);

    // 2. GET /api/models
    const modelsRes = await fetch(`${ORIGIN}/api/models`, { headers: HDRS });
    const modelsJson = await modelsRes.json();
    check('GET /api/models', modelsRes.status === 200 && Array.isArray(modelsJson.models) && modelsJson.models.length === models.length, JSON.stringify(modelsJson.modes));
    check('  /api/models has no credentials', !JSON.stringify(modelsJson).match(/api_key|token|secret/i));
    check('  /api/models modes enum', Array.isArray(modelsJson.modes) && modelsJson.modes.includes('debate'));

    // 3. POST /api/debates → 202 { debateId }
    const post = await fetch(`${ORIGIN}/api/debates`, {
      method: 'POST',
      headers: { ...HDRS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Is TypeScript good?', mode: 'compare' }),
    });
    const postJson = await post.json();
    check('POST /api/debates 202 + debateId', post.status === 202 && typeof postJson.debateId === 'string', `status=${post.status}`);

    // 4. SSE stream until result
    const events = await collectSSE(`${ORIGIN}/api/debates/${postJson.debateId}/events`);
    const types = events.map((e) => e.type);
    check('SSE emits debate_start first', types[0] === 'debate_start', types.slice(0, 3).join(','));
    check('SSE reaches result terminal', types.includes('result'), `last=${types[types.length - 1]}`);
    const startEv = events.find((e) => e.type === 'agent_start');
    check('SSE agent_start payload shape', !!startEv && typeof startEv.data.agent?.agentId === 'string' && typeof startEv.data.agent?.role === 'string');
    const completeEv = events.find((e) => e.type === 'agent_complete');
    check('SSE agent_complete has result.response', !!completeEv && typeof completeEv.data.result?.response === 'string' && typeof completeEv.data.result?.elapsedMs === 'number');
    const resultEv = events.find((e) => e.type === 'result');
    const session = resultEv?.data.session;
    check('result carries Session with session_id', !!session && typeof session.session_id === 'string');
    check('  Session.stages present', Array.isArray(session?.stages) && session.stages.length > 0);
    const invStages = (session?.stages || []).filter((st: { invocations?: unknown[] }) => Array.isArray(st.invocations) && st.invocations.length > 0);
    check('  Session.stages[].invocations present (replay view dep)', invStages.length > 0);
    const anInv = invStages.flatMap((st: { invocations?: unknown[] }) => st.invocations || [])[0] as { agent_id?: string; response_raw?: string } | undefined;
    check('  invocation has agent_id + response_raw', !!anInv && typeof anInv.agent_id === 'string' && typeof anInv.response_raw === 'string');
    check('  Session.agents present (replay view dep)', Array.isArray(session?.agents) && session.agents.length > 0);

    // 5. GET /api/sessions (should list the just-completed debate)
    const list = await fetch(`${ORIGIN}/api/sessions`, { headers: HDRS });
    const listJson = await list.json();
    check('GET /api/sessions', list.status === 200 && Array.isArray(listJson.sessions), `n=${listJson.sessions?.length}`);
    const summary = listJson.sessions?.[0];
    check('  summary has session_id + resolved_mode', !!summary && typeof summary.session_id === 'string' && typeof summary.resolved_mode === 'string');

    // 6. GET /api/sessions/:id round-trips full Session
    if (summary) {
      const detail = await fetch(`${ORIGIN}/api/sessions/${summary.session_id}`, { headers: HDRS });
      const detailJson = await detail.json();
      check('GET /api/sessions/:id full Session', detail.status === 200 && Array.isArray(detailJson.session?.stages));
    }

    // 7. Security: non-loopback Host → 403. Uses raw http since undici/fetch
    //    forbids overriding the Host header.
    const evilStatus = await rawGetStatus('/api/models', 'evil.example.com');
    check('Security rejects non-loopback Host', evilStatus === 403, `status=${evilStatus}`);
  } finally {
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  process.stdout.write(`\n${failures === 0 ? '🎉 ALL PASS' : `💥 ${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Raw HTTP GET that honors a custom Host header (fetch/undici cannot). */
function rawGetStatus(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

interface SSEEvent { type: string; data: any }
async function collectSSE(url: string): Promise<SSEEvent[]> {
  const res = await fetch(url, { headers: { ...HDRS, Accept: 'text/event-stream' } });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const out: SSEEvent[] = [];
  let buf = '';
  let curEvent = '';
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split('\n\n');
    buf = frames.pop() ?? '';
    for (const frame of frames) {
      if (frame.startsWith(':')) continue; // heartbeat comment
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) curEvent = line.slice(6).trim();
        else if (line.startsWith('data:')) {
          try { out.push({ type: curEvent, data: JSON.parse(line.slice(5).trim()) }); } catch { /* ignore */ }
        }
      }
      if (curEvent === 'result' || curEvent === 'error') { await reader.cancel(); return out; }
    }
  }
  await reader.cancel();
  return out;
}

main().catch((e) => { process.stderr.write(`SMOKE ERROR: ${e?.stack || e}\n`); process.exit(1); });
