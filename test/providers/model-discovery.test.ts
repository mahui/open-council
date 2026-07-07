/**
 * Tests for discoverModels() (src/providers/model-discovery.ts) after the
 * standard-API convergence: discovery now queries each protocol's official
 * `/models` endpoint via the vendor SDK when the corresponding env var is set,
 * falling back to the hand-maintained static catalog on error or an empty
 * result. No CLI binaries, no OAuth, no pi-ai registry.
 *
 * Strategy: mock the `@anthropic-ai/sdk` and `openai` default exports so
 * `models.list()` never touches the network (TEST-03 — we mock the external
 * SDK boundary, not the module under test's own internals).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { anthropicListMock, anthropicCtorMock, openaiListMock, openaiCtorMock } = vi.hoisted(() => ({
  anthropicListMock: vi.fn(),
  anthropicCtorMock: vi.fn(),
  openaiListMock: vi.fn(),
  openaiCtorMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    models = { list: anthropicListMock };
    constructor(opts: unknown) {
      anthropicCtorMock(opts);
    }
  },
}));

vi.mock('openai', () => ({
  default: class {
    models = { list: openaiListMock };
    constructor(opts: unknown) {
      openaiCtorMock(opts);
    }
  },
}));

import { discoverModels, discoverEndpointModels } from '../../src/providers/model-discovery.js';
import { MODEL_CATALOG } from '../../src/shared/model-catalog.js';
import { CredentialManager } from '../../src/providers/credentials/discovery.js';

// Discovery now takes an injected CredentialManager (DI, no default param). The
// manager is the *real* class driven by process.env — credential resolution is
// covered by discovery.test.ts, so here we only keep mocking the SDK boundary.
const creds = (): CredentialManager => new CredentialManager();

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  anthropicListMock.mockReset();
  anthropicCtorMock.mockReset();
  openaiListMock.mockReset();
  openaiCtorMock.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

function anthropicCatalog(): Array<{ id: string; name: string; protocol: 'anthropic'; source: string }> {
  const cat = MODEL_CATALOG.anthropic;
  return [cat.flagship, cat.balanced, cat.economy].map((m) => ({
    id: m.id, name: m.displayName, protocol: 'anthropic', source: 'official',
  }));
}

function openaiCatalog(): Array<{ id: string; name: string; protocol: 'openai'; source: string }> {
  const cat = MODEL_CATALOG.openai;
  return [cat.flagship, cat.balanced, cat.economy].map((m) => ({
    id: m.id, name: m.displayName, protocol: 'openai', source: 'official',
  }));
}

describe('discoverModels — no credentials', () => {
  it('no env keys set → empty result, no SDK constructed', async () => {
    const models = await discoverModels(creds());
    expect(models).toEqual([]);
    expect(anthropicCtorMock).not.toHaveBeenCalled();
    expect(openaiCtorMock).not.toHaveBeenCalled();
  });
});

describe('discoverModels — Anthropic', () => {
  beforeEach(() => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test';
  });

  it('maps a live models.list() page to DiscoveredModel[], reasoning-off client options (maxRetries 0)', async () => {
    anthropicListMock.mockResolvedValue({
      data: [{ id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' }],
    });

    const models = await discoverModels(creds());

    expect(models).toEqual([
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', protocol: 'anthropic', source: 'official' },
    ]);
    expect(anthropicCtorMock).toHaveBeenCalledWith({ apiKey: 'sk-ant-test', maxRetries: 0, timeout: 5000 });
  });

  it('falls back to display_name → id when display_name is absent', async () => {
    anthropicListMock.mockResolvedValue({ data: [{ id: 'claude-x' }] });
    const models = await discoverModels(creds());
    expect(models[0]?.name).toBe('claude-x');
  });

  it('an empty live page falls back to the static catalog (flagship/balanced/economy)', async () => {
    anthropicListMock.mockResolvedValue({ data: [] });
    const models = await discoverModels(creds());
    expect(models).toEqual(anthropicCatalog());
  });

  it('models.list() throwing falls back to the static catalog rather than propagating', async () => {
    anthropicListMock.mockRejectedValue(new Error('network unreachable'));
    const models = await discoverModels(creds());
    expect(models).toEqual(anthropicCatalog());
  });

  it('a fallback due to error is reported on stderr, not silently swallowed', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    anthropicListMock.mockRejectedValue(new Error('boom'));
    await discoverModels(creds());
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('anthropic'));
    stderr.mockRestore();
  });
});

describe('discoverModels — OpenAI', () => {
  beforeEach(() => {
    process.env['OPENAI_API_KEY'] = 'sk-oai-test';
  });

  it('filters /models to chat-capable families (gpt-*, o[0-9], chatgpt*), dropping embeddings/tts/etc.', async () => {
    openaiListMock.mockResolvedValue({
      data: [
        { id: 'gpt-5.4' },
        { id: 'o3' },
        { id: 'chatgpt-4o-latest' },
        { id: 'whisper-1' },
        { id: 'text-embedding-3-small' },
        { id: 'dall-e-3' },
      ],
    });

    const models = await discoverModels(creds());

    expect(models.map((m) => m.id).sort()).toEqual(['chatgpt-4o-latest', 'gpt-5.4', 'o3'].sort());
    expect(models.every((m) => m.protocol === 'openai' && m.source === 'official')).toBe(true);
    expect(openaiCtorMock).toHaveBeenCalledWith({ apiKey: 'sk-oai-test', maxRetries: 0, timeout: 5000 });
  });

  it('all non-chat models filtered out → falls back to the static catalog', async () => {
    openaiListMock.mockResolvedValue({ data: [{ id: 'whisper-1' }, { id: 'text-embedding-3-small' }] });
    const models = await discoverModels(creds());
    expect(models).toEqual(openaiCatalog());
  });

  it('models.list() throwing falls back to the static catalog', async () => {
    openaiListMock.mockRejectedValue(new Error('503'));
    const models = await discoverModels(creds());
    expect(models).toEqual(openaiCatalog());
  });
});

describe('discoverModels — both protocols credentialed', () => {
  it('concatenates Anthropic models followed by OpenAI models', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    process.env['OPENAI_API_KEY'] = 'sk-oai';
    anthropicListMock.mockResolvedValue({ data: [{ id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' }] });
    openaiListMock.mockResolvedValue({ data: [{ id: 'gpt-5.4' }] });

    const models = await discoverModels(creds());

    expect(models.map((m) => m.protocol)).toEqual(['anthropic', 'openai']);
    expect(models.map((m) => m.id)).toEqual(['claude-opus-4-6', 'gpt-5.4']);
  });
});

describe('discoverEndpointModels — custom / self-hosted endpoints', () => {
  const OLLAMA = 'http://localhost:11434/v1';

  it('OpenAI-compat: returns every model with base_url + sourceLabel and NO family filter', async () => {
    // llama/mistral/gemini ids that the official gpt/o filter would wrongly drop.
    openaiListMock.mockResolvedValue({
      data: [{ id: 'llama3.2' }, { id: 'mistral' }, { id: 'gemini-2.5-pro' }],
    });

    const models = await discoverEndpointModels({
      protocol: 'openai',
      baseUrl: OLLAMA,
      sourceLabel: 'ollama',
    });

    expect(models).toEqual([
      { id: 'llama3.2', name: 'llama3.2', protocol: 'openai', base_url: OLLAMA, source: 'ollama' },
      { id: 'mistral', name: 'mistral', protocol: 'openai', base_url: OLLAMA, source: 'ollama' },
      { id: 'gemini-2.5-pro', name: 'gemini-2.5-pro', protocol: 'openai', base_url: OLLAMA, source: 'ollama' },
    ]);
  });

  it('no apiKey → SDK is constructed with a non-empty placeholder key (no env fallback) + the base_url', async () => {
    openaiListMock.mockResolvedValue({ data: [{ id: 'llama3.2' }] });

    await discoverEndpointModels({ protocol: 'openai', baseUrl: OLLAMA, sourceLabel: 'ollama' });

    expect(openaiCtorMock).toHaveBeenCalledWith({
      baseURL: OLLAMA,
      apiKey: 'no-auth',
      maxRetries: 0,
      timeout: 5000,
    });
  });

  it('an explicit apiKey is passed through to the SDK unchanged', async () => {
    openaiListMock.mockResolvedValue({ data: [{ id: 'gpt-4o' }] });

    await discoverEndpointModels({
      protocol: 'openai',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'sk-gateway-key',
      sourceLabel: 'gateway',
    });

    expect(openaiCtorMock).toHaveBeenCalledWith({
      baseURL: 'https://gateway.example/v1',
      apiKey: 'sk-gateway-key',
      maxRetries: 0,
      timeout: 5000,
    });
  });

  it('Anthropic-compat: constructs the Anthropic SDK with base_url and maps ids', async () => {
    anthropicListMock.mockResolvedValue({ data: [{ id: 'claude-proxy-1', display_name: 'Proxy' }] });

    const models = await discoverEndpointModels({
      protocol: 'anthropic',
      baseUrl: 'https://proxy.example',
      apiKey: 'sk-x',
      sourceLabel: 'proxy',
    });

    expect(models).toEqual([
      { id: 'claude-proxy-1', name: 'claude-proxy-1', protocol: 'anthropic', base_url: 'https://proxy.example', source: 'proxy' },
    ]);
    expect(anthropicCtorMock).toHaveBeenCalledWith({
      baseURL: 'https://proxy.example',
      apiKey: 'sk-x',
      maxRetries: 0,
      timeout: 5000,
    });
  });

  it('a successful-but-empty listing returns [] (no static-catalog fallback)', async () => {
    openaiListMock.mockResolvedValue({ data: [] });
    const models = await discoverEndpointModels({ protocol: 'openai', baseUrl: OLLAMA, sourceLabel: 'ollama' });
    expect(models).toEqual([]);
  });

  it('failure → warns on stderr and returns [] without throwing (no catalog fallback)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    openaiListMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const models = await discoverEndpointModels({ protocol: 'openai', baseUrl: OLLAMA, sourceLabel: 'ollama' });

    expect(models).toEqual([]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(OLLAMA));
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
    // Distinct from the official path — must NOT mention the static catalog.
    expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('static catalog'));
    stderr.mockRestore();
  });

  it('the failure warning never leaks the API key (SEC-02)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    openaiListMock.mockRejectedValue(new Error('bad request'));

    await discoverEndpointModels({
      protocol: 'openai',
      baseUrl: 'https://gateway.example/v1',
      apiKey: 'sk-super-secret',
      sourceLabel: 'gateway',
    });

    for (const call of stderr.mock.calls) {
      expect(String(call[0])).not.toContain('sk-super-secret');
    }
    stderr.mockRestore();
  });

  // #23: discoverEndpointModels is the trust boundary for untrusted endpoint data.
  // An id that cannot be persisted safely as <id>.yaml (path traversal) is dropped
  // — otherwise it would surface later as an uncaught safePath throw at save time.
  it('drops path-traversal ids, keeps the legit ones, and warns once with the count + base_url (no key leak)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    openaiListMock.mockResolvedValue({
      data: [{ id: 'llama3.2' }, { id: '../../evil' }, { id: '/etc/passwd' }, { id: 'mistral' }],
    });

    const models = await discoverEndpointModels({
      protocol: 'openai',
      baseUrl: OLLAMA,
      apiKey: 'sk-endpoint-secret',
      sourceLabel: 'ollama',
    });

    // Only the storable ids survive; the two traversal ids are gone.
    expect(models.map((m) => m.id)).toEqual(['llama3.2', 'mistral']);

    const dropWarnings = stderr.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('dropped'));
    expect(dropWarnings).toHaveLength(1); // a single summary line, not one-per-id
    expect(dropWarnings[0]).toContain('2'); // dropped count
    expect(dropWarnings[0]).toContain(OLLAMA); // base_url provenance
    // SEC-02: the drop warning never echoes key material.
    for (const call of stderr.mock.calls) expect(String(call[0])).not.toContain('sk-endpoint-secret');
    stderr.mockRestore();
  });

  it('all ids unsafe → returns [] (with a drop warning)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    openaiListMock.mockResolvedValue({ data: [{ id: '../../evil' }, { id: '../secrets' }] });

    const models = await discoverEndpointModels({ protocol: 'openai', baseUrl: OLLAMA, sourceLabel: 'ollama' });

    expect(models).toEqual([]);
    expect(stderr.mock.calls.some((c) => String(c[0]).includes('dropped'))).toBe(true);
    stderr.mockRestore();
  });

  it('the anthropic branch is guarded by the same storability filter', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    anthropicListMock.mockResolvedValue({ data: [{ id: 'claude-proxy-1' }, { id: '../../evil' }] });

    const models = await discoverEndpointModels({
      protocol: 'anthropic',
      baseUrl: 'https://proxy.example',
      apiKey: 'sk-x',
      sourceLabel: 'proxy',
    });

    expect(models.map((m) => m.id)).toEqual(['claude-proxy-1']);
    expect(stderr.mock.calls.some((c) => String(c[0]).includes('dropped'))).toBe(true);
    stderr.mockRestore();
  });

  it('all-legit ids produce no drop warning (filter is silent when nothing is dropped)', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    openaiListMock.mockResolvedValue({ data: [{ id: 'llama3.2' }, { id: 'mistral' }] });

    await discoverEndpointModels({ protocol: 'openai', baseUrl: OLLAMA, sourceLabel: 'ollama' });

    expect(stderr.mock.calls.some((c) => String(c[0]).includes('dropped'))).toBe(false);
    stderr.mockRestore();
  });
});
