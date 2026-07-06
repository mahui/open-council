/**
 * Tests for the standard-API CredentialManager (src/providers/credentials/discovery.ts).
 *
 * After the standard-API convergence the manager is a thin, three-method shell:
 * `getApiKey` (env → key file → protocol default env), `discoverAll` (report env
 * vars + custom key files present on disk), and `saveCustomKey` (persist a
 * GUI-entered key to a 0o600 file). No OAuth, no keychain, no CLI, no pi-ai.
 *
 * Strategy: real filesystem calls against a tmpdir (TEST-04) — `PATHS.credentials`
 * is a plain (non-frozen) object field, so tests point it at a tmpdir for the
 * duration of the test and restore the original value afterwards, rather than
 * mocking node:fs wholesale (there is no OAuth/keychain surface left to isolate).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialManager } from '../../../src/providers/credentials/discovery.js';
import { PATHS } from '../../../src/config/paths.js';
import type { ModelConfig } from '../../../src/types/config.js';

function makeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'test-model',
    protocol: 'anthropic',
    model: 'claude-x',
    timeout_seconds: 120,
    capabilities: ['general'],
    priority: 100,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: true,
    ...overrides,
  };
}

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'MY_CUSTOM_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('CredentialManager.getApiKey — resolution order', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-cred-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('api_key_env takes priority when the named env var is set', () => {
    process.env['MY_CUSTOM_KEY'] = 'sk-from-env';
    process.env['ANTHROPIC_API_KEY'] = 'sk-official-fallback';
    const cm = new CredentialManager();
    expect(cm.getApiKey(makeConfig({ api_key_env: 'MY_CUSTOM_KEY' }))).toBe('sk-from-env');
  });

  it('falls back to api_key_path (a 0o600 key file) when api_key_env is unset', () => {
    const keyPath = join(dir, 'key.txt');
    writeFileSync(keyPath, 'sk-from-file\n');
    const cm = new CredentialManager();
    expect(cm.getApiKey(makeConfig({ api_key_path: keyPath }))).toBe('sk-from-file');
  });

  it('api_key_path content is trimmed of surrounding whitespace/newlines', () => {
    const keyPath = join(dir, 'key.txt');
    writeFileSync(keyPath, '  sk-padded  \n');
    const cm = new CredentialManager();
    expect(cm.getApiKey(makeConfig({ api_key_path: keyPath }))).toBe('sk-padded');
  });

  it('an api_key_path pointing at a missing file is skipped (falls through), not thrown', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-official';
    const cm = new CredentialManager();
    expect(cm.getApiKey(makeConfig({ api_key_path: join(dir, 'missing.key') }))).toBe('sk-official');
  });

  it('falls back to the protocol default env var (ANTHROPIC_API_KEY) when no explicit source is configured', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-default-anthropic';
    const cm = new CredentialManager();
    expect(cm.getApiKey(makeConfig({ protocol: 'anthropic' }))).toBe('sk-default-anthropic');
  });

  it('falls back to OPENAI_API_KEY for the openai protocol', () => {
    process.env['OPENAI_API_KEY'] = 'sk-default-openai';
    const cm = new CredentialManager();
    expect(cm.getApiKey(makeConfig({ protocol: 'openai' }))).toBe('sk-default-openai');
  });

  it('an empty-string env var value is treated as unset (falls through)', () => {
    process.env['MY_CUSTOM_KEY'] = '';
    process.env['ANTHROPIC_API_KEY'] = 'sk-fallback';
    const cm = new CredentialManager();
    expect(cm.getApiKey(makeConfig({ api_key_env: 'MY_CUSTOM_KEY' }))).toBe('sk-fallback');
  });

  it('no key resolvable anywhere → null (caller decides whether an empty key is acceptable)', () => {
    const cm = new CredentialManager();
    expect(cm.getApiKey(makeConfig())).toBeNull();
  });

  it('api_key_env takes priority even over an existing api_key_path', () => {
    process.env['MY_CUSTOM_KEY'] = 'sk-env-wins';
    const keyPath = join(dir, 'key.txt');
    writeFileSync(keyPath, 'sk-file-loses');
    const cm = new CredentialManager();
    expect(cm.getApiKey(makeConfig({ api_key_env: 'MY_CUSTOM_KEY', api_key_path: keyPath }))).toBe('sk-env-wins');
  });
});

describe('CredentialManager.discoverAll / saveCustomKey', () => {
  const originalCredentialsDir = PATHS.credentials;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'oc-cred-discover-'));
    (PATHS as { credentials: string }).credentials = dir;
  });
  afterEach(() => {
    (PATHS as { credentials: string }).credentials = originalCredentialsDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('no env vars, no credentials dir contents → empty report', () => {
    const cm = new CredentialManager();
    expect(cm.discoverAll()).toEqual({});
  });

  it('reports ANTHROPIC_API_KEY as a valid env-sourced credential', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    const cm = new CredentialManager();
    expect(cm.discoverAll()).toEqual({
      anthropic: { source: 'env', status: 'valid', env_var: 'ANTHROPIC_API_KEY' },
    });
  });

  it('reports both official env vars when both are set', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant';
    process.env['OPENAI_API_KEY'] = 'sk-oai';
    const cm = new CredentialManager();
    const report = cm.discoverAll();
    expect(report['anthropic']).toEqual({ source: 'env', status: 'valid', env_var: 'ANTHROPIC_API_KEY' });
    expect(report['openai']).toEqual({ source: 'env', status: 'valid', env_var: 'OPENAI_API_KEY' });
  });

  it('an empty-string env var is not reported as present', () => {
    process.env['ANTHROPIC_API_KEY'] = '';
    const cm = new CredentialManager();
    expect(cm.discoverAll()).toEqual({});
  });

  it('discovers a custom-endpoint key file saved under credentials/custom-<name>.key', () => {
    writeFileSync(join(dir, 'custom-mylab.key'), 'sk-custom', { mode: 0o600 });
    const cm = new CredentialManager();
    expect(cm.discoverAll()).toEqual({
      'custom:mylab': { source: 'file', status: 'valid', path: join(dir, 'custom-mylab.key') },
    });
  });

  it('ignores files in the credentials dir that do not match the custom-<name>.key pattern', () => {
    writeFileSync(join(dir, 'random-file.txt'), 'not a key');
    writeFileSync(join(dir, 'custom-mylab.key'), 'sk-custom');
    const cm = new CredentialManager();
    expect(Object.keys(cm.discoverAll())).toEqual(['custom:mylab']);
  });

  it('combines env-sourced and file-sourced entries in one report', () => {
    process.env['OPENAI_API_KEY'] = 'sk-oai';
    writeFileSync(join(dir, 'custom-gw.key'), 'sk-custom');
    const cm = new CredentialManager();
    const report = cm.discoverAll();
    expect(Object.keys(report).sort()).toEqual(['custom:gw', 'openai']);
  });

  it('a missing credentials directory is tolerated (no crash, empty file-sourced entries)', () => {
    rmSync(dir, { recursive: true, force: true });
    const cm = new CredentialManager();
    expect(cm.discoverAll()).toEqual({});
  });

  it('saveCustomKey writes the key to custom-<name>.key with 0o600 permissions', () => {
    const cm = new CredentialManager();
    const path = cm.saveCustomKey('mylab', 'sk-secret-value');

    expect(path).toBe(join(dir, 'custom-mylab.key'));
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('sk-secret-value');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('saveCustomKey creates the credentials directory if it does not yet exist', () => {
    rmSync(dir, { recursive: true, force: true });
    const cm = new CredentialManager();
    const path = cm.saveCustomKey('mylab', 'sk-secret');
    expect(existsSync(path)).toBe(true);
  });

  it('a key saved via saveCustomKey is immediately visible via discoverAll (round-trip)', () => {
    const cm = new CredentialManager();
    cm.saveCustomKey('roundtrip', 'sk-rt');
    expect(cm.discoverAll()).toHaveProperty('custom:roundtrip');
  });

  it('saveCustomKey never echoes the key material back — only the path is returned', () => {
    const cm = new CredentialManager();
    const path = cm.saveCustomKey('mylab', 'sk-should-not-leak');
    expect(path).not.toContain('sk-should-not-leak');
  });
});

describe('CredentialManager.resolveOfficialKey — official-endpoint key resolution', () => {
  it('returns ANTHROPIC_API_KEY for the anthropic protocol', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-official-ant';
    expect(new CredentialManager().resolveOfficialKey('anthropic')).toBe('sk-official-ant');
  });

  it('returns OPENAI_API_KEY for the openai protocol', () => {
    process.env['OPENAI_API_KEY'] = 'sk-official-oai';
    expect(new CredentialManager().resolveOfficialKey('openai')).toBe('sk-official-oai');
  });

  it('returns null when the protocol default env var is unset', () => {
    expect(new CredentialManager().resolveOfficialKey('anthropic')).toBeNull();
  });

  it('treats an empty-string env var as unset (null)', () => {
    process.env['OPENAI_API_KEY'] = '';
    expect(new CredentialManager().resolveOfficialKey('openai')).toBeNull();
  });

  it('reads ONLY the env var — never a custom-<name>.key file (those bind to a base_url, not a protocol)', () => {
    // Real file on disk under a tmpdir PATHS.credentials, no env set: if
    // resolveOfficialKey consulted key files at all it would find this one and
    // return its contents. It must stay null, proving the method truly never
    // looks at the filesystem.
    const originalCredentialsDir = PATHS.credentials;
    const dir = mkdtempSync(join(tmpdir(), 'oc-cred-official-'));
    (PATHS as { credentials: string }).credentials = dir;
    try {
      writeFileSync(join(dir, 'custom-anthropic.key'), 'sk-file-should-be-ignored', { mode: 0o600 });
      expect(new CredentialManager().resolveOfficialKey('anthropic')).toBeNull();
    } finally {
      (PATHS as { credentials: string }).credentials = originalCredentialsDir;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('CredentialManager — no cross-instance state', () => {
  it('two independent CredentialManager instances resolve identically from the same env (stateless)', () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-shared';
    const a = new CredentialManager();
    const b = new CredentialManager();
    expect(a.getApiKey(makeConfig())).toBe(b.getApiKey(makeConfig()));
  });
});
