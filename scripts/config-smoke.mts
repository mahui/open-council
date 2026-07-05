/**
 * End-to-end integration smoke for the Web GUI settings面 (task #42 Step 2.5).
 * Boots a REAL server (mock adapter + temp config/credentials/session dirs) and
 * exercises the config routes, asserting the front-end↔server wire contract that
 * web/store.js consumes: ConfigDTO shape, per-model version tokens, PUT/PATCH
 * optimistic lock (incl. the 409 `{ error, current }` envelope store.js unwraps),
 * custom-endpoint credential ingress (SEC-02 redaction), rescan summary, and that
 * a config write actually drives the next debate (chairman swap + disabled model
 * dropped) via the SSE stream.
 *
 * Isolated from the user's real ~/.council: config + credentials + sessions all
 * live under a temp dir. Run: npx tsx scripts/config-smoke.mts
 */
import { serve } from '@hono/node-server';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const PORT = 3798;
const ORIGIN = `http://localhost:${PORT}`;
const HDRS = { Host: `localhost:${PORT}`, Origin: ORIGIN };
const WRITE_HDRS = { ...HDRS, 'Content-Type': 'application/json' };
const HEX64 = /^[0-9a-f]{64}$/;

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  process.stdout.write(`${cond ? '✅' : '❌'} ${name}${extra ? ` — ${extra}` : ''}\n`);
  if (!cond) failures++;
}

// Mock adapter: streams a chunk, returns a canned consensus-friendly answer.
const mockAdapter: InvocationAdapter = {
  async invoke(config: ModelConfig, _prompt: string, onChunk?: OnChunk): Promise<InvocationResult> {
    onChunk?.('thinking… ');
    return {
      response: `Answer from ${config.name}. I agree with the others. Final: yes. Score: 9/10.`,
      elapsed_ms: 3,
      invocation_mode: 'api',
      timed_out: false,
      token_usage: { input_tokens: 10, output_tokens: 20 },
    };
  },
  async healthCheck(): Promise<HealthStatus> {
    return { level: 'healthy', message: 'ok', checked_at: new Date().toISOString() };
  },
};

function model(name: string, provider: string): ModelConfig {
  return ModelConfigSchema.parse({ name, provider, invocation: 'api', capabilities: ['reasoning'] });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'oc-config-smoke-'));
  const credentialsDir = join(dir, 'credentials');
  const loader = new ConfigLoader(dir);
  const models = [model('mock-a', 'anthropic'), model('mock-b', 'openai'), model('mock-c', 'google')];
  for (const m of models) loader.saveModelConfig(m);
  loader.saveCouncilConfig(
    assembleConfig({
      generalOverride: { default_mode: 'auto', default_chairman: 'mock-a', min_agents: 2, max_agents: 5 },
      prefer: ['mock-a', 'mock-b', 'mock-c'],
      chairman: 'mock-a',
      base: null,
    }),
  );

  const credentialManager = new CredentialManager();
  const runtime = new RuntimeConfig(buildSnapshot({ loader, credentialManager, adapter: mockAdapter }));
  const store = new SessionStore(join(dir, 'sessions'));
  const manager = new DebateManager({ runtime, store });
  const app = createApp({
    manager, store, runtime, loader, credentialManager, port: PORT, webRoot: dir, credentialsDir,
  });
  const server = serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' });
  await new Promise((r) => setTimeout(r, 300));

  try {
    // 1. GET /api/config — redacted projection + optimistic-lock tokens.
    const cfg = await getJSON('/api/config');
    check('GET /api/config version is a content hash', HEX64.test(cfg.version), cfg.version);
    check('  general has all editable fields',
      cfg.general.default_mode === 'auto' && cfg.general.default_chairman === 'mock-a'
      && typeof cfg.general.min_agents === 'number' && typeof cfg.general.language === 'string');
    check('  prefer projected', Array.isArray(cfg.prefer) && cfg.prefer.includes('mock-a'));
    check('  models[] carry per-file version tokens (store.js PATCH lock)',
      cfg.models.length === 3 && cfg.models.every((m: any) => HEX64.test(m.version)));
    check('  readOnly section present', cfg.readOnly && typeof cfg.readOnly.schema_version === 'number');
    check('  no secrets in body', !/api_key|credential_path|token|apiKey/i.test(JSON.stringify(cfg)));

    // 2. PUT /api/config — change chairman with the current version token.
    const put = await reqJSON('PUT', '/api/config', { general: { default_chairman: 'mock-b' }, version: cfg.version });
    check('PUT /api/config 200 + new chairman', put.status === 200 && put.data.general.default_chairman === 'mock-b', `status=${put.status}`);
    check('  version rotated after write', HEX64.test(put.data.version) && put.data.version !== cfg.version);

    // 3. Runtime reload is observable on the launch form contract.
    const modelsAfterPut = await getJSON('/api/models');
    check('GET /api/models reflects new defaultChairman (runtime reload)', modelsAfterPut.defaultChairman === 'mock-b', modelsAfterPut.defaultChairman);

    // 4. PUT with a stale version → 409 { error, current } (store.js unwraps .current).
    const stale = await reqJSON('PUT', '/api/config', { general: { default_mode: 'debate' }, version: 'stale-token' });
    check('PUT stale version → 409', stale.status === 409, `status=${stale.status}`);
    check('  409 body carries { current: ConfigDTO } for rebase', !!stale.data?.current && HEX64.test(stale.data.current.version));

    // 5. PATCH /api/models/:name — disable mock-c with its own version token.
    const freshCfg = await getJSON('/api/config');
    const cModel = freshCfg.models.find((m: any) => m.name === 'mock-c');
    const patch = await reqJSON('PATCH', '/api/models/mock-c', { enabled: false, version: cModel.version });
    check('PATCH disable mock-c → 200', patch.status === 200 && patch.data.enabled === false, `status=${patch.status}`);
    check('  returned token is fresh (store.js rebases the row)', HEX64.test(patch.data.version) && patch.data.version !== cModel.version);
    const modelsAfterPatch = await getJSON('/api/models');
    check('  disabled model dropped from launch model list', !modelsAfterPatch.models.some((m: any) => m.name === 'mock-c'));

    // 6. PATCH stale version → 409 { error, current: ModelSettingDTO }.
    const patchStale = await reqJSON('PATCH', '/api/models/mock-a', { enabled: false, version: 'stale' });
    check('PATCH stale version → 409', patchStale.status === 409, `status=${patchStale.status}`);
    check('  409 body carries model current for row rebase', !!patchStale.data?.current && HEX64.test(patchStale.data.current.version));

    // 7. End-to-end: the config writes drive the next debate via SSE. Run this
    //    BEFORE rescan — rescan legitimately rebuilds the adapter (new creds may
    //    exist), which in a mock smoke would swap our mock adapter for a real one.
    const post = await reqJSON('POST', '/api/debates', { question: 'Is TypeScript good?', mode: 'compare' });
    check('POST /api/debates → 202 + debateId', post.status === 202 && typeof post.data.debateId === 'string', `status=${post.status}`);
    const events = await collectSSE(`${ORIGIN}/api/debates/${post.data.debateId}/events`);
    check('SSE reaches result terminal', events.some((e) => e.type === 'result'));
    const agentDTOs = events
      .filter((e) => e.type === 'agent_start' || e.type === 'agent_complete')
      .map((e) => e.data.agent)
      .filter(Boolean);
    const chairman = agentDTOs.find((a: any) => a.isChairman);
    check('SSE chairman agent uses the newly-set chairman (mock-b)', !!chairman && chairman.modelName === 'mock-b', chairman?.modelName ?? 'no chairman agent');
    check('SSE debate excludes the disabled model (mock-c)', !agentDTOs.some((a: any) => a.modelName === 'mock-c'));

    // 8. POST /api/providers/custom — credential ingress, redaction (SEC-02).
    const secret = 'sk-smoke-secret-987';
    const custom = await reqJSON('POST', '/api/providers/custom', {
      name: 'SmokeLab', baseUrl: 'http://localhost:1234/v1', modelIds: ['x', 'y'], apiKey: secret,
    });
    check('POST /api/providers/custom → 200 { added, ok }',
      custom.status === 200 && custom.data.ok === true && Array.isArray(custom.data.added) && custom.data.added.length === 2, `status=${custom.status}`);
    check('  response never echoes the key', !JSON.stringify(custom.data).includes(secret));
    const keyPath = join(credentialsDir, 'custom-smokelab.key');
    check('  key persisted 0o600 under the injected temp credentialsDir',
      existsSync(keyPath) && (statSync(keyPath).mode & 0o777) === 0o600 && readFileSync(keyPath, 'utf-8') === secret);
    const customRaw = loader.readModelConfigRaw('custom:smokelab:x');
    check('  model YAML stores the path, not the key', !!customRaw && !customRaw.includes(secret));

    // 9. POST /api/setup/rescan — discovery summary, no secret / path leak.
    //    (Last, since it rebuilds the adapter from a fresh credential set.)
    const rescan = await reqJSON('POST', '/api/setup/rescan', {});
    check('POST /api/setup/rescan → 200 summary shape',
      rescan.status === 200 && Array.isArray(rescan.data.credentials) && Array.isArray(rescan.data.models.added) && Array.isArray(rescan.data.models.existing));
    check('  credential entries omit filesystem path', rescan.data.credentials.every((c: any) => !('path' in c)));
  } finally {
    server.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }

  process.stdout.write(`\n${failures === 0 ? '🎉 ALL PASS' : `💥 ${failures} FAILURE(S)`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

async function getJSON(path: string): Promise<any> {
  const r = await fetch(`${ORIGIN}${path}`, { headers: { ...HDRS, Accept: 'application/json' } });
  return r.json();
}

/** Status-aware request mirroring store.js reqJSON: never throws, returns { status, data }. */
async function reqJSON(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const r = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: WRITE_HDRS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = null;
  try { data = await r.json(); } catch { /* empty body */ }
  return { status: r.status, data };
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
      if (frame.startsWith(':')) continue; // heartbeat
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
