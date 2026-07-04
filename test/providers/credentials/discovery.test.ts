/**
 * Tests for CredentialManager (src/providers/credentials/discovery.ts).
 *
 * CredentialManager reads real paths under the user's home directory
 * (KNOWN_CREDENTIALS.*, PATHS.credentials — computed from node:os homedir() at
 * module load) and writes refreshed OAuth tokens back to disk. To keep tests
 * safe (never touching a developer's real ~/.codex, ~/.gemini or ~/.council)
 * and independent of what happens to exist on the host, node:fs and
 * node:child_process are mocked at the module level (TEST-03: this mocks the
 * I/O/external-library boundary, not CredentialManager's own logic). pi-ai's
 * OAuth surface is mocked too, since real token refresh is pi-ai's concern,
 * not this module's — our contract is that CredentialManager calls it with the
 * right arguments and persists/propagates the result correctly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => { throw new Error('unexpected real read'); }),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => { throw new Error('no keychain in tests'); }),
}));

vi.mock('@mariozechner/pi-ai', () => ({
  getEnvApiKey: vi.fn(() => undefined),
}));

vi.mock('@mariozechner/pi-ai/oauth', () => ({
  getOAuthProvider: vi.fn(() => undefined),
  getOAuthProviders: vi.fn(() => []),
  getOAuthApiKey: vi.fn(),
}));

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { getEnvApiKey } from '@mariozechner/pi-ai';
import { getOAuthProvider, getOAuthProviders, getOAuthApiKey } from '@mariozechner/pi-ai/oauth';
import { CredentialManager } from '../../../src/providers/credentials/discovery.js';
import { CredentialNotFoundError } from '../../../src/types/errors.js';
import { KNOWN_CREDENTIALS, PATHS } from '../../../src/config/paths.js';
import { join } from 'node:path';
import type { OAuthCredentials, OAuthProviderInterface, OAuthLoginCallbacks } from '@mariozechner/pi-ai';

function stubCallbacks(): OAuthLoginCallbacks {
  return { onAuth: vi.fn(), onPrompt: vi.fn() };
}

function resetMocks(): void {
  vi.mocked(existsSync).mockReset().mockReturnValue(false);
  vi.mocked(readFileSync).mockReset().mockImplementation(() => { throw new Error('ENOENT'); });
  vi.mocked(writeFileSync).mockReset();
  vi.mocked(getEnvApiKey).mockReset().mockReturnValue(undefined);
  vi.mocked(getOAuthProvider).mockReset().mockReturnValue(undefined);
  vi.mocked(getOAuthProviders).mockReset().mockReturnValue([]);
  vi.mocked(getOAuthApiKey).mockReset();
  vi.mocked(execSync).mockReset().mockImplementation(() => { throw new Error('no keychain in tests'); });
}

describe('CredentialManager.discoverAll — env vars', () => {
  beforeEach(resetMocks);
  afterEach(() => vi.restoreAllMocks());

  it('an env-provided key is discovered, cached, and reported as valid', async () => {
    vi.mocked(getEnvApiKey).mockImplementation((provider: unknown) => (provider === 'anthropic' ? 'sk-env-anthropic' : undefined));

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['anthropic']).toEqual({ source: 'env', status: 'valid' });
    expect(mgr.hasCredential('anthropic')).toBe(true);
    await expect(mgr.getApiKey('anthropic')).resolves.toBe('sk-env-anthropic');
    expect(mgr.getDirectSource('anthropic')).toBe('env');
  });

  it('no env vars, no OAuth, no legacy files → empty report and no credentials found', async () => {
    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report).toEqual({});
    expect(mgr.hasCredential('openai')).toBe(false);
    await expect(mgr.getApiKey('openai')).rejects.toThrow(CredentialNotFoundError);
  });
});

describe('CredentialManager.discoverAll — legacy codex auth.json (~/.codex/auth.json)', () => {
  beforeEach(resetMocks);
  afterEach(() => vi.restoreAllMocks());

  it('parses tokens.access_token from a mock ~/.codex/auth.json and registers it under openai-codex + openai', async () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => p === KNOWN_CREDENTIALS.openai);
    vi.mocked(readFileSync).mockImplementation((p: unknown) => {
      if (p === KNOWN_CREDENTIALS.openai) {
        return JSON.stringify({
          tokens: {
            access_token: 'sk-codex-access',
            refresh_token: 'sk-codex-refresh',
            expires_at: 1999999999999,
            account_id: 'acct-123',
          },
        });
      }
      throw new Error('ENOENT');
    });
    vi.mocked(getOAuthProvider).mockImplementation((id: unknown) => {
      if (id === 'openai-codex') {
        return {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          getApiKey: (creds: OAuthCredentials) => `apikey:${creds.access}`,
        } as unknown as OAuthProviderInterface;
      }
      return undefined;
    });

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['openai-codex']).toEqual({
      source: 'file',
      status: 'valid',
      path: KNOWN_CREDENTIALS.openai,
    });
    expect(mgr.hasCredential('openai')).toBe(true);
    expect(mgr.hasCredential('openai-codex')).toBe(true);
    expect(mgr.getDirectSource('openai-codex')).toBe('oauth');
    await expect(mgr.getApiKey('openai')).resolves.toBe('apikey:sk-codex-access');
  });

  it('auth.json missing entirely → no cache entry, no report entry (same as "not found", not an error)', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['openai-codex']).toBeUndefined();
    expect(mgr.hasCredential('openai')).toBe(false);
  });

  it('auth.json has no tokens.access_token field → treated as absent, no report entry', async () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => p === KNOWN_CREDENTIALS.openai);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ tokens: {} }) as never);

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['openai-codex']).toBeUndefined();
    expect(mgr.hasCredential('openai')).toBe(false);
  });

  it('valid file shape but the OAuth provider\'s getApiKey() throws → status "parse_error"', async () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => p === KNOWN_CREDENTIALS.openai);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      tokens: { access_token: 'sk-x', refresh_token: '', expires_at: 0 },
    }) as never);
    vi.mocked(getOAuthProvider).mockImplementation((id: unknown) => {
      if (id === 'openai-codex') {
        return {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          getApiKey: () => { throw new Error('malformed token'); },
        } as unknown as OAuthProviderInterface;
      }
      return undefined;
    });

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['openai-codex']).toEqual({
      source: 'file',
      status: 'parse_error',
      path: KNOWN_CREDENTIALS.openai,
    });
    expect(mgr.hasCredential('openai-codex')).toBe(false);
  });
});

describe('CredentialManager — environment variables take priority over legacy files', () => {
  beforeEach(resetMocks);
  afterEach(() => vi.restoreAllMocks());

  it('when both an env key and a codex auth.json exist for "openai", getApiKey("openai") returns the env value', async () => {
    vi.mocked(getEnvApiKey).mockImplementation((provider: unknown) => (provider === 'openai' ? 'sk-env-openai' : undefined));
    vi.mocked(existsSync).mockImplementation((p: unknown) => p === KNOWN_CREDENTIALS.openai);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      tokens: { access_token: 'sk-file-codex', refresh_token: '', expires_at: 0 },
    }) as never);
    vi.mocked(getOAuthProvider).mockImplementation((id: unknown) => {
      if (id === 'openai-codex') {
        return {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          getApiKey: (creds: OAuthCredentials) => `apikey:${creds.access}`,
        } as unknown as OAuthProviderInterface;
      }
      return undefined;
    });

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    // Env is recorded first and 'openai' is only overwritten by the legacy-file
    // path if it wasn't already cached — so env wins for the 'openai' lookup.
    expect(report['openai']).toEqual({ source: 'env', status: 'valid' });
    expect(mgr.getDirectSource('openai')).toBe('env');
    await expect(mgr.getApiKey('openai')).resolves.toBe('sk-env-openai');

    // The file-based credential is still independently discovered and usable
    // under its specific pi-ai provider id.
    expect(report['openai-codex']).toEqual({ source: 'file', status: 'valid', path: KNOWN_CREDENTIALS.openai });
    expect(mgr.getDirectSource('openai-codex')).toBe('oauth');
  });
});

describe('CredentialManager.discoverAll — stored OAuth credentials (~/.council/credentials/<id>.json)', () => {
  beforeEach(resetMocks);
  afterEach(() => vi.restoreAllMocks());

  function stubProvider(id: string): void {
    vi.mocked(getOAuthProviders).mockReturnValue([
      { id, name: id, getApiKey: vi.fn(), login: vi.fn(), refreshToken: vi.fn() } as unknown as OAuthProviderInterface,
    ]);
  }

  const credPath = (id: string): string => join(PATHS.credentials, `${id}.json`);

  it('valid, non-expired stored credentials → status "valid" (newCredentials === stored, no rewrite)', async () => {
    stubProvider('anthropic');
    const stored: OAuthCredentials = { access: 'tok-a', refresh: 'ref-a', expires: 0 };
    vi.mocked(existsSync).mockImplementation((p: unknown) => p === credPath('anthropic'));
    vi.mocked(readFileSync).mockImplementation((p: unknown) => (p === credPath('anthropic') ? JSON.stringify(stored) : (() => { throw new Error('ENOENT'); })()));
    // discovery.ts parses the file itself (a fresh object each time), so to exercise the
    // "unchanged" branch we must echo back the exact object reference pi-ai was given,
    // not a separately-constructed literal with equal contents.
    vi.mocked(getOAuthApiKey).mockImplementation(async (providerId, credentials) => ({
      apiKey: 'resolved-key',
      newCredentials: credentials[providerId]!,
    }));

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['anthropic']).toEqual({ source: 'file', status: 'valid', path: credPath('anthropic') });
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
    expect(mgr.hasCredential('anthropic')).toBe(true);
  });

  it('expired stored credentials trigger a refresh → status "refreshed" and the new token is persisted to disk', async () => {
    stubProvider('anthropic');
    const stored: OAuthCredentials = { access: 'old-tok', refresh: 'ref-a', expires: 0 };
    const refreshed: OAuthCredentials = { access: 'new-tok', refresh: 'ref-a', expires: 9999999999999 };
    vi.mocked(existsSync).mockImplementation((p: unknown) => p === credPath('anthropic'));
    vi.mocked(readFileSync).mockImplementation((p: unknown) => (p === credPath('anthropic') ? JSON.stringify(stored) : (() => { throw new Error('ENOENT'); })()));
    vi.mocked(getOAuthApiKey).mockResolvedValue({ apiKey: 'new-api-key', newCredentials: refreshed });

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['anthropic']).toEqual({ source: 'file', status: 'refreshed', path: credPath('anthropic') });
    expect(vi.mocked(getOAuthApiKey)).toHaveBeenCalledWith('anthropic', { anthropic: stored });
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(
      credPath('anthropic'),
      JSON.stringify(refreshed, null, 2),
      { mode: 0o600 },
    );
  });

  it('refresh throws (token unrecoverable) → status "expired", no crash', async () => {
    stubProvider('anthropic');
    const stored: OAuthCredentials = { access: 'dead-tok', refresh: 'ref-a', expires: 0 };
    vi.mocked(existsSync).mockImplementation((p: unknown) => p === credPath('anthropic'));
    vi.mocked(readFileSync).mockImplementation((p: unknown) => (p === credPath('anthropic') ? JSON.stringify(stored) : (() => { throw new Error('ENOENT'); })()));
    vi.mocked(getOAuthApiKey).mockRejectedValue(new Error('refresh_token invalid'));

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['anthropic']).toEqual({ source: 'file', status: 'expired', path: credPath('anthropic') });
    expect(mgr.hasCredential('anthropic')).toBe(false);
  });

  it('no stored credential file for the OAuth provider → silently skipped (no report entry)', async () => {
    stubProvider('anthropic');
    vi.mocked(existsSync).mockReturnValue(false);

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['anthropic']).toBeUndefined();
    expect(mgr.hasCredential('anthropic')).toBe(false);
    expect(vi.mocked(getOAuthApiKey)).not.toHaveBeenCalled();
  });
});

describe('CredentialManager — misc accessors', () => {
  beforeEach(resetMocks);
  afterEach(() => vi.restoreAllMocks());

  it('getPiaiProvider falls back to the legacy provider name when nothing is cached', () => {
    const mgr = new CredentialManager();
    expect(mgr.getPiaiProvider('some-uncached-provider')).toBe('some-uncached-provider');
  });

  it('getAvailableProviders returns the distinct set of cached pi-ai provider ids', async () => {
    vi.mocked(getEnvApiKey).mockImplementation((provider: unknown) => (provider === 'anthropic' ? 'sk-a' : undefined));

    const mgr = new CredentialManager();
    await mgr.discoverAll();

    expect(mgr.getAvailableProviders()).toEqual(['anthropic']);
  });

  it('getLoginableProviders maps pi-ai OAuth providers to {id, name} pairs', () => {
    vi.mocked(getOAuthProviders).mockReturnValue([
      { id: 'anthropic', name: 'Anthropic', getApiKey: vi.fn(), login: vi.fn(), refreshToken: vi.fn() } as unknown as OAuthProviderInterface,
    ]);

    const mgr = new CredentialManager();
    expect(mgr.getLoginableProviders()).toEqual([{ id: 'anthropic', name: 'Anthropic' }]);
  });

  it('getOAuthCredentials returns undefined when no OAuth credential is cached for the provider', () => {
    const mgr = new CredentialManager();
    expect(mgr.getOAuthCredentials('anthropic')).toBeUndefined();
  });
});

describe('CredentialManager.login', () => {
  beforeEach(resetMocks);
  afterEach(() => vi.restoreAllMocks());

  it('runs the OAuth login flow, persists credentials, and caches under both the pi-ai id and its legacy alias', async () => {
    const creds: OAuthCredentials = { access: 'new-access', refresh: 'new-refresh', expires: 0 };
    vi.mocked(getOAuthProvider).mockImplementation((id: unknown) => {
      if (id === 'openai-codex') {
        return {
          id: 'openai-codex',
          name: 'OpenAI Codex',
          login: vi.fn().mockResolvedValue(creds),
          getApiKey: (c: OAuthCredentials) => `k:${c.access}`,
        } as unknown as OAuthProviderInterface;
      }
      return undefined;
    });

    const mgr = new CredentialManager();
    const result = await mgr.login('openai-codex', stubCallbacks());

    expect(result).toBe(creds);
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(
      join(PATHS.credentials, 'openai-codex.json'),
      JSON.stringify(creds, null, 2),
      { mode: 0o600 },
    );
    // 'openai-codex' legacy-maps to 'openai' — a different name — so both cache slots are populated.
    expect(mgr.hasCredential('openai-codex')).toBe(true);
    expect(mgr.hasCredential('openai')).toBe(true);
    expect(mgr.getDirectSource('openai-codex')).toBe('oauth');
    expect(mgr.getDirectSource('openai')).toBe('oauth');
    await expect(mgr.getApiKey('openai')).resolves.toBe('k:new-access');
  });

  it('unknown OAuth provider id → throws without touching the filesystem', async () => {
    vi.mocked(getOAuthProvider).mockReturnValue(undefined);

    const mgr = new CredentialManager();

    await expect(mgr.login('not-a-real-provider', stubCallbacks())).rejects.toThrow(
      'Unknown OAuth provider: not-a-real-provider',
    );
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });
});

describe('CredentialManager.discoverAll — OAuth id vs. legacy-name aliasing', () => {
  beforeEach(resetMocks);
  afterEach(() => vi.restoreAllMocks());

  const credPath = (id: string): string => join(PATHS.credentials, `${id}.json`);

  it('an OAuth id whose legacy name differs (google-gemini-cli → google) is also cached under the legacy name', async () => {
    vi.mocked(getOAuthProviders).mockReturnValue([
      { id: 'google-gemini-cli', name: 'Gemini CLI', getApiKey: vi.fn(), login: vi.fn(), refreshToken: vi.fn() } as unknown as OAuthProviderInterface,
    ]);
    const stored: OAuthCredentials = { access: 'g-tok', refresh: 'g-ref', expires: 0 };
    vi.mocked(existsSync).mockImplementation((p: unknown) => p === credPath('google-gemini-cli'));
    vi.mocked(readFileSync).mockImplementation((p: unknown) => (p === credPath('google-gemini-cli') ? JSON.stringify(stored) : (() => { throw new Error('ENOENT'); })()));
    // Echo back the exact object reference pi-ai was handed, so the "unchanged" (status: valid)
    // branch is exercised rather than "refreshed" (discovery.ts parses its own fresh copy from disk).
    vi.mocked(getOAuthApiKey).mockImplementation(async (providerId, credentials) => ({
      apiKey: 'resolved-google-key',
      newCredentials: credentials[providerId]!,
    }));

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['google-gemini-cli']).toEqual({ source: 'file', status: 'valid', path: credPath('google-gemini-cli') });
    expect(mgr.hasCredential('google-gemini-cli')).toBe(true);
    expect(mgr.hasCredential('google')).toBe(true);
    expect(mgr.getDirectSource('google')).toBe('oauth');
  });

  it('does not overwrite the legacy alias slot when it is already occupied (e.g. by an env credential)', async () => {
    vi.mocked(getEnvApiKey).mockImplementation((provider: unknown) => (provider === 'google' ? 'sk-env-google' : undefined));
    vi.mocked(getOAuthProviders).mockReturnValue([
      { id: 'google-gemini-cli', name: 'Gemini CLI', getApiKey: vi.fn(), login: vi.fn(), refreshToken: vi.fn() } as unknown as OAuthProviderInterface,
    ]);
    const stored: OAuthCredentials = { access: 'g-tok', refresh: 'g-ref', expires: 0 };
    vi.mocked(existsSync).mockImplementation((p: unknown) => p === credPath('google-gemini-cli'));
    vi.mocked(readFileSync).mockImplementation((p: unknown) => (p === credPath('google-gemini-cli') ? JSON.stringify(stored) : (() => { throw new Error('ENOENT'); })()));
    vi.mocked(getOAuthApiKey).mockResolvedValue({ apiKey: 'resolved-google-key', newCredentials: stored });

    const mgr = new CredentialManager();
    await mgr.discoverAll();

    // 'google-gemini-cli' is still discovered on its own pi-ai id...
    expect(mgr.hasCredential('google-gemini-cli')).toBe(true);
    // ...but the shared legacy 'google' slot stays with the env credential that got there first.
    expect(mgr.getDirectSource('google')).toBe('env');
    await expect(mgr.getApiKey('google')).resolves.toBe('sk-env-google');
  });
});

describe('CredentialManager.discoverAll — legacy Gemini CLI file (~/.gemini/oauth_creds.json)', () => {
  const realFetch = globalThis.fetch;

  beforeEach(resetMocks);
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = realFetch;
  });

  function stubGeminiProviders(opts: { antigravity: 'present' | 'throws' | 'absent' }): void {
    vi.mocked(getOAuthProvider).mockImplementation((id: unknown) => {
      if (id === 'google-gemini-cli') {
        return {
          id: 'google-gemini-cli',
          name: 'Gemini CLI',
          getApiKey: (c: OAuthCredentials) => `gc:${c.access}:${c['projectId'] ?? 'none'}`,
        } as unknown as OAuthProviderInterface;
      }
      if (id === 'google-antigravity') {
        if (opts.antigravity === 'absent') return undefined;
        return {
          id: 'google-antigravity',
          name: 'Antigravity',
          getApiKey: () => {
            if (opts.antigravity === 'throws') throw new Error('antigravity key derivation failed');
            return 'antigravity-key';
          },
        } as unknown as OAuthProviderInterface;
      }
      return undefined;
    });
  }

  it('full success path: reads the file, discovers the project id, and registers gemini-cli + antigravity + google', async () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => p === KNOWN_CREDENTIALS.google);
    vi.mocked(readFileSync).mockImplementation((p: unknown) => (p === KNOWN_CREDENTIALS.google
      ? JSON.stringify({ access_token: 'gtok', refresh_token: 'gref', expiry_date: 123 })
      : (() => { throw new Error('ENOENT'); })()));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ cloudaicompanionProject: 'proj-123' }),
    }) as unknown as typeof fetch;
    stubGeminiProviders({ antigravity: 'present' });

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['google-gemini-cli']).toEqual({ source: 'file', status: 'valid', path: KNOWN_CREDENTIALS.google });
    expect(report['google-antigravity']).toEqual({ source: 'file', status: 'valid', path: KNOWN_CREDENTIALS.google });
    expect(mgr.hasCredential('google-gemini-cli')).toBe(true);
    expect(mgr.hasCredential('google-antigravity')).toBe(true);
    expect(mgr.hasCredential('google')).toBe(true);
    await expect(mgr.getApiKey('google-gemini-cli')).resolves.toContain('proj-123');
  });

  it('project-id lookup fails (fetch not ok) → gemini-cli is still registered, just without a projectId', async () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => p === KNOWN_CREDENTIALS.google);
    vi.mocked(readFileSync).mockImplementation((p: unknown) => (p === KNOWN_CREDENTIALS.google
      ? JSON.stringify({ access_token: 'gtok', refresh_token: 'gref', expiry_date: 123 })
      : (() => { throw new Error('ENOENT'); })()));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 }) as unknown as typeof fetch;
    stubGeminiProviders({ antigravity: 'absent' });

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['google-gemini-cli']).toEqual({ source: 'file', status: 'valid', path: KNOWN_CREDENTIALS.google });
    // Antigravity provider unavailable in pi-ai → falls back to reusing gemini-cli's apiKey string.
    expect(mgr.hasCredential('google-antigravity')).toBe(true);
    await expect(mgr.getApiKey('google-gemini-cli')).resolves.toContain(':none');
  });

  it('antigravity getApiKey() throws → gemini-cli registration still succeeds, antigravity falls back', async () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => p === KNOWN_CREDENTIALS.google);
    vi.mocked(readFileSync).mockImplementation((p: unknown) => (p === KNOWN_CREDENTIALS.google
      ? JSON.stringify({ access_token: 'gtok', refresh_token: 'gref', expiry_date: 123 })
      : (() => { throw new Error('ENOENT'); })()));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;
    stubGeminiProviders({ antigravity: 'throws' });

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['google-gemini-cli']).toEqual({ source: 'file', status: 'valid', path: KNOWN_CREDENTIALS.google });
    expect(mgr.hasCredential('google-antigravity')).toBe(true); // fallback path still registers it
  });

  it('oauth_creds.json missing the access_token field → treated as absent, no report entry', async () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => p === KNOWN_CREDENTIALS.google);
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ refresh_token: 'r' }) as never);

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['google-gemini-cli']).toBeUndefined();
    expect(mgr.hasCredential('google-gemini-cli')).toBe(false);
  });

  it('getOAuthProvider("google-gemini-cli") throws inside the try block → status "parse_error"', async () => {
    vi.mocked(existsSync).mockImplementation((p: unknown) => p === KNOWN_CREDENTIALS.google);
    vi.mocked(readFileSync).mockImplementation((p: unknown) => (p === KNOWN_CREDENTIALS.google
      ? JSON.stringify({ access_token: 'gtok', refresh_token: 'gref', expiry_date: 123 })
      : (() => { throw new Error('ENOENT'); })()));
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }) as unknown as typeof fetch;
    vi.mocked(getOAuthProvider).mockImplementation((id: unknown) => {
      if (id === 'google-gemini-cli') {
        return {
          id: 'google-gemini-cli',
          name: 'Gemini CLI',
          getApiKey: () => { throw new Error('bad token'); },
        } as unknown as OAuthProviderInterface;
      }
      return undefined;
    });

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['google-gemini-cli']).toEqual({ source: 'file', status: 'parse_error', path: KNOWN_CREDENTIALS.google });
  });
});

describe.skipIf(process.platform !== 'darwin')('CredentialManager.discoverAll — macOS Keychain (Claude Code OAuth)', () => {
  beforeEach(resetMocks);
  afterEach(() => vi.restoreAllMocks());

  it('valid keychain entry → anthropic registered from "keychain:Claude Code-credentials"', async () => {
    vi.mocked(execSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'keychain-tok', refreshToken: 'keychain-ref', expiresAt: 999 },
    }) as never);
    vi.mocked(getOAuthProvider).mockImplementation((id: unknown) => {
      if (id === 'anthropic') {
        return {
          id: 'anthropic',
          name: 'Anthropic',
          getApiKey: (c: OAuthCredentials) => `keychain-key:${c.access}`,
        } as unknown as OAuthProviderInterface;
      }
      return undefined;
    });

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['anthropic']).toEqual({ source: 'file', status: 'valid', path: 'keychain:Claude Code-credentials' });
    await expect(mgr.getApiKey('anthropic')).resolves.toBe('keychain-key:keychain-tok');
  });

  it('keychain read throws (not signed into Claude Code) → no report entry, no crash', async () => {
    vi.mocked(execSync).mockImplementation(() => { throw new Error('security: item not found'); });

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['anthropic']).toBeUndefined();
    expect(mgr.hasCredential('anthropic')).toBe(false);
  });

  it('keychain entry present but getApiKey() throws → status "expired"', async () => {
    vi.mocked(execSync).mockReturnValue(JSON.stringify({
      claudeAiOauth: { accessToken: 'keychain-tok', refreshToken: '', expiresAt: 0 },
    }) as never);
    vi.mocked(getOAuthProvider).mockImplementation((id: unknown) => {
      if (id === 'anthropic') {
        return {
          id: 'anthropic',
          name: 'Anthropic',
          getApiKey: () => { throw new Error('bad keychain token'); },
        } as unknown as OAuthProviderInterface;
      }
      return undefined;
    });

    const mgr = new CredentialManager();
    const report = await mgr.discoverAll();

    expect(report['anthropic']).toEqual({ source: 'file', status: 'expired', path: 'keychain:Claude Code-credentials' });
  });
});
