/**
 * Rescan → prefer maintenance (task #47). A rescan that surfaces new models must
 * upsert them AND keep council.yaml's `prefer` in step — otherwise "models are
 * there but prefer drifted". Discovery is mocked so the append is deterministic
 * without depending on the host's real credentials.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
import type { RescanSummaryDTO } from '../../src/server/protocol.js';
import type { DiscoveredModel } from '../../src/providers/model-discovery.js';

// Control what a rescan "discovers". Injected via the mock below.
let discovered: DiscoveredModel[] = [];
vi.mock('../../src/providers/model-discovery.js', () => ({
  discoverModels: vi.fn(async () => discovered),
}));

const PORT = 8831;
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
    protocol: 'anthropic', provider: 'anthropic', model: 'm', timeout_seconds: 120,
    capabilities: ['general'], priority: 100, max_concurrent: 1, resource_weight: 1,
    enabled: true, streaming: true, ...overrides,
  };
}

interface Harness {
  app: ReturnType<typeof createApp>;
  loader: ConfigLoader;
  dir: string;
}

function makeHarness(models: ModelConfig[], prefer: string[]): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'oc-rescan-test-'));
  const loader = new ConfigLoader(dir);
  for (const m of models) loader.saveModelConfig(m);

  const config = assembleConfig({
    generalOverride: { default_mode: 'auto', default_chairman: prefer[0] ?? '', min_agents: 2, max_agents: 5 },
    prefer,
    chairman: prefer[0] ?? '',
    base: null,
  });
  loader.saveCouncilConfig(config);

  const credentialManager = new CredentialManager();
  vi.spyOn(CredentialManager.prototype, 'discoverAll').mockReturnValue({});
  const runtime = new RuntimeConfig(buildSnapshot({ loader, credentialManager, adapter: mockAdapter() }));

  const store = {
    saveSession: vi.fn(async () => {}),
    getSession: vi.fn(async () => null),
    listSessions: vi.fn(async () => []),
  } as unknown as SessionStore;
  const manager = new DebateManager({ runtime, store, eventLogOptions: { ttlMs: 60_000 } });

  const app = createApp({
    manager, store, runtime, loader, credentialManager, port: PORT, webRoot: tmpdir(),
    credentialsDir: join(dir, 'credentials'),
  });
  return { app, loader, dir };
}

let harness: Harness | undefined;
afterEach(() => {
  if (harness) rmSync(harness.dir, { recursive: true, force: true });
  harness = undefined;
  discovered = [];
  vi.restoreAllMocks();
});

describe('POST /api/setup/rescan — prefer maintenance', () => {
  it('appends a newly-discovered model to prefer, keeping it de-duplicated', async () => {
    harness = makeHarness([baseModel({ name: 'claude' })], ['claude']);
    discovered = [
      { id: 'claude', name: 'claude', protocol: 'anthropic', source: 'official' }, // already exists
      { id: 'gemini', name: 'gemini', protocol: 'openai', source: 'official' },     // new
    ];

    const res = await harness.app.request('http://x/api/setup/rescan', {
      method: 'POST', headers: WRITE_HEADERS, body: '{}',
    });
    expect(res.status).toBe(200);
    const summary = (await res.json()) as RescanSummaryDTO;
    expect(summary.models.added).toEqual(['gemini']);
    expect(summary.models.existing).toEqual(['claude']);

    // council.yaml's prefer now includes the new model, still de-duplicated.
    const prefer = harness.loader.loadCouncilConfig().routing.default.prefer;
    expect(prefer).toEqual(['claude', 'gemini']);
  });

  it('leaves prefer untouched (and clean) when nothing new is discovered', async () => {
    harness = makeHarness([baseModel({ name: 'claude' })], ['claude']);
    discovered = [{ id: 'claude', name: 'claude', protocol: 'anthropic', source: 'official' }];

    const res = await harness.app.request('http://x/api/setup/rescan', {
      method: 'POST', headers: WRITE_HEADERS, body: '{}',
    });
    expect(res.status).toBe(200);
    const summary = (await res.json()) as RescanSummaryDTO;
    expect(summary.models.added).toEqual([]);

    const prefer = harness.loader.loadCouncilConfig().routing.default.prefer;
    expect(prefer).toEqual(['claude']);
  });

  it('does not resurrect duplicates: append + gate keeps prefer a set', async () => {
    // Seed already has claude in prefer; discovery re-surfaces it as "existing"
    // and adds gemini. The result must not contain a duplicate claude.
    harness = makeHarness([baseModel({ name: 'claude' })], ['claude']);
    discovered = [{ id: 'gemini', name: 'gemini', protocol: 'openai', source: 'official' }];

    await harness.app.request('http://x/api/setup/rescan', {
      method: 'POST', headers: WRITE_HEADERS, body: '{}',
    });
    const prefer = harness.loader.loadCouncilConfig().routing.default.prefer;
    expect(new Set(prefer).size).toBe(prefer.length);
    expect(prefer).toContain('gemini');
  });
});
