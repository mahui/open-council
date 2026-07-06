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

import { discoverModels } from '../../src/providers/model-discovery.js';
import { MODEL_CATALOG } from '../../src/shared/model-catalog.js';

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
    const models = await discoverModels();
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

    const models = await discoverModels();

    expect(models).toEqual([
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', protocol: 'anthropic', source: 'official' },
    ]);
    expect(anthropicCtorMock).toHaveBeenCalledWith({ apiKey: 'sk-ant-test', maxRetries: 0, timeout: 5000 });
  });

  it('falls back to display_name → id when display_name is absent', async () => {
    anthropicListMock.mockResolvedValue({ data: [{ id: 'claude-x' }] });
    const models = await discoverModels();
    expect(models[0]?.name).toBe('claude-x');
  });

  it('an empty live page falls back to the static catalog (flagship/balanced/economy)', async () => {
    anthropicListMock.mockResolvedValue({ data: [] });
    const models = await discoverModels();
    expect(models).toEqual(anthropicCatalog());
  });

  it('models.list() throwing falls back to the static catalog rather than propagating', async () => {
    anthropicListMock.mockRejectedValue(new Error('network unreachable'));
    const models = await discoverModels();
    expect(models).toEqual(anthropicCatalog());
  });

  it('a fallback due to error is reported on stderr, not silently swallowed', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    anthropicListMock.mockRejectedValue(new Error('boom'));
    await discoverModels();
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

    const models = await discoverModels();

    expect(models.map((m) => m.id).sort()).toEqual(['chatgpt-4o-latest', 'gpt-5.4', 'o3'].sort());
    expect(models.every((m) => m.protocol === 'openai' && m.source === 'official')).toBe(true);
    expect(openaiCtorMock).toHaveBeenCalledWith({ apiKey: 'sk-oai-test', maxRetries: 0, timeout: 5000 });
  });

  it('all non-chat models filtered out → falls back to the static catalog', async () => {
    openaiListMock.mockResolvedValue({ data: [{ id: 'whisper-1' }, { id: 'text-embedding-3-small' }] });
    const models = await discoverModels();
    expect(models).toEqual(openaiCatalog());
  });

  it('models.list() throwing falls back to the static catalog', async () => {
    openaiListMock.mockRejectedValue(new Error('503'));
    const models = await discoverModels();
    expect(models).toEqual(openaiCatalog());
  });
});

describe('discoverModels — both protocols credentialed', () => {
  it('concatenates Anthropic models followed by OpenAI models', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    process.env['OPENAI_API_KEY'] = 'sk-oai';
    anthropicListMock.mockResolvedValue({ data: [{ id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6' }] });
    openaiListMock.mockResolvedValue({ data: [{ id: 'gpt-5.4' }] });

    const models = await discoverModels();

    expect(models.map((m) => m.protocol)).toEqual(['anthropic', 'openai']);
    expect(models.map((m) => m.id)).toEqual(['claude-opus-4-6', 'gpt-5.4']);
  });
});
