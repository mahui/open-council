/**
 * Tests for discoverModels() (src/providers/model-discovery.ts).
 *
 * Strategy: mock @mariozechner/pi-ai (getModels), @mariozechner/pi-ai/oauth
 * (getOAuthProvider), and node:child_process (execFileSync, which hasBinary()
 * uses under the hood) so discovery never touches a real network or the host's
 * installed CLI binaries. A fake CredentialManager is built inline per test
 * (TEST-03 — we mock the external-library/OS boundary, not the module under
 * test's own internals).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@mariozechner/pi-ai', () => ({
  getModels: vi.fn(),
}));

vi.mock('@mariozechner/pi-ai/oauth', () => ({
  getOAuthProvider: vi.fn(() => null),
}));

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => { throw new Error('binary not found'); }),
}));

import { discoverModels } from '../../src/providers/model-discovery.js';
import { MODEL_CATALOG } from '../../src/shared/model-catalog.js';
import type { CredentialManager } from '../../src/providers/credentials/discovery.js';
import { getModels } from '@mariozechner/pi-ai';
import { getOAuthProvider } from '@mariozechner/pi-ai/oauth';
import { execFileSync } from 'node:child_process';

function makeModel(id: string, provider: string, name = id): unknown {
  return { id, provider, name };
}

function makeFakeCredentialManager(overrides: Partial<CredentialManager> = {}): CredentialManager {
  return {
    discoverAll: vi.fn(),
    getApiKey: vi.fn().mockResolvedValue(''),
    hasCredential: vi.fn().mockReturnValue(false),
    getPiaiProvider: vi.fn().mockReturnValue(''),
    getAvailableProviders: vi.fn().mockReturnValue([]),
    getOAuthCredentials: vi.fn().mockReturnValue(undefined),
    getDirectSource: vi.fn().mockReturnValue(undefined),
    login: vi.fn(),
    getLoginableProviders: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as CredentialManager;
}

describe('discoverModels — API models from credentialed providers', () => {
  beforeEach(() => {
    vi.mocked(getModels).mockReset();
    vi.mocked(getOAuthProvider).mockReset().mockReturnValue(null as never);
    vi.mocked(execFileSync).mockReset().mockImplementation(() => { throw new Error('not found'); });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns API models for each credentialed provider', async () => {
    const credManager = makeFakeCredentialManager({
      getAvailableProviders: vi.fn().mockReturnValue(['anthropic']),
    });
    vi.mocked(getModels).mockReturnValue([
      makeModel('claude-x', 'anthropic'),
    ] as never);

    const models = await discoverModels(credManager);

    expect(models).toEqual([
      { id: 'claude-x', name: 'claude-x', provider: 'anthropic', invocation: 'api' },
    ]);
  });

  it('a provider unrecognized by pi-ai (getModels throws) is skipped without throwing', async () => {
    const credManager = makeFakeCredentialManager({
      getAvailableProviders: vi.fn().mockReturnValue(['unknown-provider']),
    });
    vi.mocked(getModels).mockImplementation(() => { throw new Error('unrecognized provider'); });

    await expect(discoverModels(credManager)).resolves.toEqual([]);
  });

  it('enabledProviders whitelist filters out providers not in the set', async () => {
    const credManager = makeFakeCredentialManager({
      getAvailableProviders: vi.fn().mockReturnValue(['anthropic', 'openai']),
    });
    vi.mocked(getModels).mockImplementation((provider: unknown) => {
      if (provider === 'anthropic') return [makeModel('claude-x', 'anthropic')] as never;
      if (provider === 'openai') return [makeModel('gpt-x', 'openai')] as never;
      return [] as never;
    });

    const models = await discoverModels(credManager, new Set(['anthropic']));

    expect(models.map(m => m.provider)).toEqual(['anthropic']);
  });

  it('OAuth-specific provider is expanded to also query its generic sibling (google-gemini-cli → +google)', async () => {
    const credManager = makeFakeCredentialManager({
      getAvailableProviders: vi.fn().mockReturnValue(['google-gemini-cli']),
    });
    vi.mocked(getModels).mockImplementation((provider: unknown) => {
      if (provider === 'google-gemini-cli') return [makeModel('gemini-cli-model', 'google-gemini-cli')] as never;
      if (provider === 'google') return [makeModel('gemini-generic-model', 'google')] as never;
      return [] as never;
    });

    const models = await discoverModels(credManager);

    const ids = models.map(m => m.id).sort();
    expect(ids).toEqual(['gemini-cli-model', 'gemini-generic-model']);
    expect(vi.mocked(getModels)).toHaveBeenCalledWith('google-gemini-cli');
    expect(vi.mocked(getModels)).toHaveBeenCalledWith('google');
  });

  it('duplicate model id+provider from overlapping expansion is deduplicated', async () => {
    const credManager = makeFakeCredentialManager({
      getAvailableProviders: vi.fn().mockReturnValue(['google-gemini-cli', 'google-antigravity']),
    });
    // Both providers happen to surface the exact same (provider, id) pair.
    vi.mocked(getModels).mockImplementation((provider: unknown) => {
      if (provider === 'google-gemini-cli') return [makeModel('shared-model', 'google')] as never;
      if (provider === 'google-antigravity') return [] as never;
      if (provider === 'google') return [makeModel('shared-model', 'google')] as never;
      if (provider === 'google-vertex') return [] as never;
      return [] as never;
    });

    const models = await discoverModels(credManager);
    const sharedMatches = models.filter(m => m.id === 'shared-model' && m.provider === 'google' && m.invocation === 'api');

    expect(sharedMatches).toHaveLength(1);
  });

  it('applies the OAuth provider\'s modifyModels hook when present (e.g. GitHub Copilot base URL rewrite)', async () => {
    const credManager = makeFakeCredentialManager({
      getAvailableProviders: vi.fn().mockReturnValue(['github-copilot']),
      getOAuthCredentials: vi.fn().mockReturnValue({ access: 'tok', refresh: '', expires: 0 }),
    });
    vi.mocked(getModels).mockReturnValue([makeModel('copilot-model', 'github-copilot')] as never);
    vi.mocked(getOAuthProvider).mockReturnValue({
      id: 'github-copilot',
      name: 'GitHub Copilot',
      modifyModels: vi.fn(() => [makeModel('copilot-model-modified', 'github-copilot')]),
    } as never);

    const models = await discoverModels(credManager);

    expect(models).toEqual([
      { id: 'copilot-model-modified', name: 'copilot-model-modified', provider: 'github-copilot', invocation: 'api' },
    ]);
  });

  it('no credentialed providers and no CLI binaries → empty result', async () => {
    const credManager = makeFakeCredentialManager({ getAvailableProviders: vi.fn().mockReturnValue([]) });

    const models = await discoverModels(credManager);

    expect(models).toEqual([]);
  });
});

describe('discoverModels — CLI binary discovery', () => {
  beforeEach(() => {
    vi.mocked(getModels).mockReset().mockReturnValue([] as never);
    vi.mocked(getOAuthProvider).mockReset().mockReturnValue(null as never);
    vi.mocked(execFileSync).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no credentialed providers, "claude" binary present → returns Claude CLI models only', async () => {
    const credManager = makeFakeCredentialManager({ getAvailableProviders: vi.fn().mockReturnValue([]) });
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      if (argv[0] === 'claude') return Buffer.from('/usr/local/bin/claude');
      throw new Error('not found');
    });

    const models = await discoverModels(credManager);

    expect(models.every(m => m.invocation === 'cli')).toBe(true);
    expect(models.map(m => m.id)).toEqual(['claude-sonnet-4-6', 'claude-opus-4-6']);
  });

  it('"codex" and "gemini" binaries present → returns both CLI model sets', async () => {
    const credManager = makeFakeCredentialManager({ getAvailableProviders: vi.fn().mockReturnValue([]) });
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      if (argv[0] === 'codex' || argv[0] === 'gemini') return Buffer.from('/usr/local/bin/found');
      throw new Error('not found');
    });

    const models = await discoverModels(credManager);
    const ids = models.map(m => m.id).sort();

    expect(ids).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro', 'gpt-5.4', 'gpt-5.4-mini'].sort());
  });

  it('no binaries found at all → no CLI models added', async () => {
    const credManager = makeFakeCredentialManager({ getAvailableProviders: vi.fn().mockReturnValue([]) });
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('not found'); });

    const models = await discoverModels(credManager);

    expect(models).toEqual([]);
  });

  it('CLI model IDs are sourced from the shared catalog, not hardcoded (drift guard)', async () => {
    const credManager = makeFakeCredentialManager({ getAvailableProviders: vi.fn().mockReturnValue([]) });
    // All three CLI binaries present.
    vi.mocked(execFileSync).mockImplementation(() => Buffer.from('/usr/local/bin/found'));

    const models = await discoverModels(credManager);
    const cliIds = models.filter(m => m.invocation === 'cli').map(m => m.id).sort();

    const catalogCliIds = Object.values(MODEL_CATALOG)
      .flatMap(c => c.cliModels.map(m => m.id))
      .sort();

    expect(cliIds).toEqual(catalogCliIds);
  });

  it('API credential and CLI binary for the same underlying provider both appear (different invocation modes)', async () => {
    const credManager = makeFakeCredentialManager({
      getAvailableProviders: vi.fn().mockReturnValue(['anthropic']),
    });
    vi.mocked(getModels).mockReturnValue([makeModel('claude-sonnet-4-6', 'anthropic')] as never);
    vi.mocked(execFileSync).mockImplementation((...args: unknown[]) => {
      const argv = args[1] as string[];
      if (argv[0] === 'claude') return Buffer.from('/usr/local/bin/claude');
      throw new Error('not found');
    });

    const models = await discoverModels(credManager);

    const apiEntry = models.find(m => m.id === 'claude-sonnet-4-6' && m.invocation === 'api');
    const cliEntry = models.find(m => m.id === 'claude-sonnet-4-6' && m.invocation === 'cli');
    expect(apiEntry).toBeDefined();
    expect(cliEntry).toBeDefined();
  });
});
