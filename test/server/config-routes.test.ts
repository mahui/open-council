import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/server/app.js';
import { DebateManager } from '../../src/server/debate-manager.js';
import { RuntimeConfig, buildSnapshot } from '../../src/server/runtime-config.js';
import { ConfigLoader } from '../../src/config/loader.js';
import { CredentialManager } from '../../src/providers/credentials/discovery.js';
import { assembleConfig } from '../../src/config/assemble-council.js';
import type { InvocationAdapter, HealthStatus } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { SessionStore } from '../../src/storage/session-store.js';
import type { ConfigDTO, ModelSettingDTO, RescanSummaryDTO } from '../../src/server/protocol.js';

const PORT = 8830;
const HEADERS = { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` };
const WRITE_HEADERS = { ...HEADERS, 'content-type': 'application/json' };

function mockAdapter(): InvocationAdapter {
  return {
    invoke: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue({
      level: 'healthy', message: 'OK', checked_at: new Date().toISOString(),
    } satisfies HealthStatus),
  };
}

function baseModel(overrides: Partial<ModelConfig> & { name: string }): ModelConfig {
  return {
    invocation: 'api', provider: 'anthropic', model: 'm', timeout_seconds: 120,
    capabilities: ['general'], priority: 100, max_concurrent: 1, resource_weight: 1,
    enabled: true, streaming: true, ...overrides,
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  loader: ConfigLoader;
  runtime: RuntimeConfig;
  dir: string;
}

/** Seed a temp config dir with a council.yaml + model files, wired into createApp. */
function makeHarness(models: ModelConfig[]): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'oc-config-test-'));
  const loader = new ConfigLoader(dir);
  for (const m of models) loader.saveModelConfig(m);

  const enabledNames = models.filter((m) => m.enabled).map((m) => m.name);
  const config = assembleConfig({
    generalOverride: {
      default_mode: 'auto',
      default_chairman: enabledNames[0] ?? '',
      min_agents: 2,
      max_agents: 5,
    },
    prefer: enabledNames,
    chairman: enabledNames[0] ?? '',
    base: null,
  });
  loader.saveCouncilConfig(config);

  const credentialManager = new CredentialManager();
  const runtime = new RuntimeConfig(buildSnapshot({ loader, credentialManager, adapter: mockAdapter() }));

  const store = {
    saveSession: vi.fn(async () => {}),
    getSession: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
  } as unknown as SessionStore;
  const manager = new DebateManager({ runtime, store, eventLogOptions: { ttlMs: 60_000 } });

  const app = createApp({
    manager, store, runtime, loader, credentialManager, port: PORT, webRoot: tmpdir(),
    // Keep custom-endpoint key files inside the temp dir — never touch the
    // user's real ~/.council/credentials (cleaned up in afterEach).
    credentialsDir: join(dir, 'credentials'),
  });
  return { app, loader, runtime, dir };
}

async function getConfig(h: Harness): Promise<ConfigDTO> {
  const res = await h.app.request('http://x/api/config', { headers: HEADERS });
  expect(res.status).toBe(200);
  return (await res.json()) as ConfigDTO;
}

let harness: Harness | undefined;
afterEach(() => {
  if (harness) rmSync(harness.dir, { recursive: true, force: true });
  harness = undefined;
});

describe('GET /api/config — redaction', () => {
  it('projects general/prefer/models + readOnly, never leaks credentials', async () => {
    harness = makeHarness([
      baseModel({ name: 'claude', api_key_env: 'ANTHROPIC_API_KEY' }),
      baseModel({
        name: 'custom:local:llama', provider: 'custom:local', model: 'llama',
        api_base_url: 'http://localhost:11434/v1', api_credential_path: '/tmp/nope.key',
      }),
    ]);
    const dto = await getConfig(harness);

    expect(dto.version).toMatch(/^[0-9a-f]{64}$/);
    expect(dto.general.default_mode).toBe('auto');
    expect(dto.prefer).toContain('claude');
    expect(dto.readOnly.schema_version).toBe(1);

    const custom = dto.models.find((m) => m.name === 'custom:local:llama');
    expect(custom?.isCustom).toBe(true);
    expect(custom?.apiBaseUrl).toBe('http://localhost:11434/v1');
    expect(custom?.hasCredentialFile).toBe(false); // path doesn't exist

    // Each model carries its own per-file optimistic-lock token (§4.3).
    for (const m of dto.models) expect(m.version).toMatch(/^[0-9a-f]{64}$/);

    // No secret-ish fields anywhere in the response body.
    const raw = JSON.stringify(dto);
    for (const forbidden of ['api_key_env', 'api_credential_path', 'ANTHROPIC_API_KEY', 'apiKey', 'token']) {
      expect(raw).not.toContain(forbidden);
    }
  });
});

describe('PUT /api/config — merge + optimistic lock', () => {
  it('merges editable fields, preserves untouched hand-tuned fields', async () => {
    harness = makeHarness([baseModel({ name: 'claude' }), baseModel({ name: 'gemini', provider: 'google' })]);
    // Hand-tune a read-only field directly on disk that PUT must not clobber.
    const before = harness.loader.loadCouncilConfig();
    before.output.show_scores = false;
    harness.loader.saveCouncilConfig(before);

    const dto = await getConfig(harness);
    const res = await harness.app.request('http://x/api/config', {
      method: 'PUT', headers: WRITE_HEADERS,
      body: JSON.stringify({ general: { default_chairman: 'gemini' }, version: dto.version }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as ConfigDTO;
    expect(updated.general.default_chairman).toBe('gemini');

    // Untouched field survived; runtime picked up the new chairman.
    expect(harness.loader.loadCouncilConfig().output.show_scores).toBe(false);
    expect(harness.runtime.current.defaultChairman).toBe('gemini');
  });

  it('rejects an unknown chairman with 400', async () => {
    harness = makeHarness([baseModel({ name: 'claude' })]);
    const dto = await getConfig(harness);
    const res = await harness.app.request('http://x/api/config', {
      method: 'PUT', headers: WRITE_HEADERS,
      body: JSON.stringify({ general: { default_chairman: 'ghost' }, version: dto.version }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 with the current config when the version is stale', async () => {
    harness = makeHarness([baseModel({ name: 'claude' })]);
    const res = await harness.app.request('http://x/api/config', {
      method: 'PUT', headers: WRITE_HEADERS,
      body: JSON.stringify({ general: { default_mode: 'debate' }, version: 'stale-token' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; current: ConfigDTO };
    expect(body.current.version).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('PATCH /api/models/:name — enable toggle', () => {
  it('flips enabled on disk and reloads the runtime, own version lock', async () => {
    harness = makeHarness([baseModel({ name: 'claude' }), baseModel({ name: 'gemini', provider: 'google' })]);
    const dto = await getConfig(harness);
    const model = dto.models.find((m) => m.name === 'gemini');
    expect(model?.enabled).toBe(true);
    expect(model?.version).toMatch(/^[0-9a-f]{64}$/);

    // Echo back the per-model version token from the GET projection (frontend flow).
    const res = await harness.app.request('http://x/api/models/gemini', {
      method: 'PATCH', headers: WRITE_HEADERS,
      body: JSON.stringify({ enabled: false, version: model!.version }),
    });
    expect(res.status).toBe(200);
    const patched = (await res.json()) as ModelSettingDTO;
    expect(patched.enabled).toBe(false);
    // The write changed the file, so the returned lock token must be fresh.
    expect(patched.version).toMatch(/^[0-9a-f]{64}$/);
    expect(patched.version).not.toBe(model!.version);

    expect(harness.loader.loadModelConfig('gemini')?.enabled).toBe(false);
    expect(harness.runtime.current.models.map((m) => m.name)).not.toContain('gemini');
  });

  it('returns 404 for an unknown model', async () => {
    harness = makeHarness([baseModel({ name: 'claude' })]);
    const res = await harness.app.request('http://x/api/models/ghost', {
      method: 'PATCH', headers: WRITE_HEADERS,
      body: JSON.stringify({ enabled: false, version: 'x' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/providers/custom — credential ingress', () => {
  it('persists the key to a 0o600 file, never echoes it', async () => {
    harness = makeHarness([baseModel({ name: 'claude' })]);
    const secret = 'sk-super-secret-value-123';
    const res = await harness.app.request('http://x/api/providers/custom', {
      method: 'POST', headers: WRITE_HEADERS,
      body: JSON.stringify({
        name: 'MyLab', baseUrl: 'http://localhost:1234/v1', modelIds: ['a', 'b'], apiKey: secret,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { added: string[]; ok: boolean };
    expect(body.ok).toBe(true);
    expect(body.added).toEqual(['custom:mylab:a', 'custom:mylab:b']);
    expect(JSON.stringify(body)).not.toContain(secret);

    // Key landed in a 0o600 file; the model YAML only stores the path, not the key.
    const model = harness.loader.loadModelConfig('custom:mylab:a');
    expect(model?.api_credential_path).toBeTruthy();
    const keyPath = model!.api_credential_path!;
    expect(existsSync(keyPath)).toBe(true);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(keyPath, 'utf-8')).toBe(secret);
    const modelRaw = harness.loader.readModelConfigRaw('custom:mylab:a');
    expect(modelRaw).not.toContain(secret);

    // Key file lives under the injected temp credentialsDir → afterEach's
    // rmSync(dir) cleans it; this belt-and-braces removal keeps the test hermetic.
    rmSync(keyPath, { force: true });
    expect(keyPath.startsWith(harness.dir)).toBe(true);
  });

  it('rejects a non-http base URL with 400', async () => {
    harness = makeHarness([baseModel({ name: 'claude' })]);
    const res = await harness.app.request('http://x/api/providers/custom', {
      method: 'POST', headers: WRITE_HEADERS,
      body: JSON.stringify({ name: 'lab', baseUrl: 'ftp://x/y', modelIds: ['a'] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/setup/rescan — discovery summary', () => {
  it('returns a well-formed summary without leaking secrets', async () => {
    harness = makeHarness([baseModel({ name: 'claude' })]);
    const res = await harness.app.request('http://x/api/setup/rescan', {
      method: 'POST', headers: WRITE_HEADERS, body: '{}',
    });
    expect(res.status).toBe(200);
    const summary = (await res.json()) as RescanSummaryDTO;
    expect(Array.isArray(summary.credentials)).toBe(true);
    expect(Array.isArray(summary.models.added)).toBe(true);
    expect(Array.isArray(summary.models.existing)).toBe(true);
    for (const cred of summary.credentials) {
      expect(typeof cred.provider).toBe('string');
      expect(['env', 'file']).toContain(cred.source);
      // Path/home structure must not leak.
      expect(cred).not.toHaveProperty('path');
    }
  });
});
