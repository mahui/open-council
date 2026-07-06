import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';
import {
  migrateModelConfigRaw,
  migrateCouncilConfigRaw,
  MIGRATE_REASON,
} from '../../src/config/migrate.js';
import { ConfigLoader } from '../../src/config/loader.js';

const EMPTY_ENV: Record<string, string | undefined> = {};
const KEYED_ENV: Record<string, string | undefined> = {
  ANTHROPIC_API_KEY: 'sk-ant',
  OPENAI_API_KEY: 'sk-oai',
};

describe('migrateModelConfigRaw — classification table', () => {
  it('already v2 (has protocol) → ok, no rewrite', () => {
    const r = migrateModelConfigRaw({ name: 'x', protocol: 'openai', model: 'gpt-5' });
    expect(r.status).toBe('ok');
    expect(r.config).toBeUndefined();
  });

  it('custom endpoint (api_base_url) → converted, openai protocol by default', () => {
    const r = migrateModelConfigRaw(
      {
        name: 'local',
        invocation: 'api',
        provider: 'custom',
        model: 'llama3',
        api_base_url: 'http://localhost:11434/v1',
        api_credential_path: '/keys/local.key',
      },
      EMPTY_ENV,
    );
    expect(r.status).toBe('converted');
    expect(r.config?.protocol).toBe('openai');
    expect(r.config?.base_url).toBe('http://localhost:11434/v1');
    expect(r.config?.api_key_path).toBe('/keys/local.key');
    expect(r.config?.enabled).toBe(true);
  });

  it('custom anthropic-compatible endpoint → converted, anthropic protocol', () => {
    const r = migrateModelConfigRaw(
      {
        name: 'proxy',
        invocation: 'api',
        model: 'claude-x',
        api_base_url: 'https://gw.example.com/anthropic',
      },
      EMPTY_ENV,
    );
    expect(r.status).toBe('converted');
    expect(r.config?.protocol).toBe('anthropic');
  });

  it('provider anthropic + key present → converted official anthropic', () => {
    const r = migrateModelConfigRaw(
      { name: 'claude', invocation: 'api', provider: 'anthropic', model: 'claude-opus' },
      KEYED_ENV,
    );
    expect(r.status).toBe('converted');
    expect(r.config?.protocol).toBe('anthropic');
    expect(r.config?.api_key_env).toBe('ANTHROPIC_API_KEY');
    expect(r.config?.base_url).toBeUndefined(); // official endpoint
    expect(r.config?.enabled).toBe(true);
  });

  it('provider openai + key present → converted official openai', () => {
    const r = migrateModelConfigRaw(
      { name: 'gpt', invocation: 'api', provider: 'openai', model: 'gpt-5' },
      KEYED_ENV,
    );
    expect(r.status).toBe('converted');
    expect(r.config?.protocol).toBe('openai');
    expect(r.config?.api_key_env).toBe('OPENAI_API_KEY');
  });

  it('explicit api_key_env keeps model enabled even when env var is unset', () => {
    const r = migrateModelConfigRaw(
      { name: 'gpt', invocation: 'api', provider: 'openai', model: 'gpt-5', api_key_env: 'MY_KEY' },
      EMPTY_ENV,
    );
    expect(r.status).toBe('converted');
    expect(r.config?.api_key_env).toBe('MY_KEY');
  });

  it('provider anthropic/openai without any key → disabled (needs key)', () => {
    const r = migrateModelConfigRaw(
      { name: 'gpt', invocation: 'api', provider: 'openai', model: 'gpt-5' },
      EMPTY_ENV,
    );
    expect(r.status).toBe('disabled');
    expect(r.reason).toBe(MIGRATE_REASON.noKey);
    expect(r.config?.enabled).toBe(false);
    expect(r.config?.legacy_disabled_reason).toBe(MIGRATE_REASON.noKey);
  });

  it('invocation cli → disabled (CLI removed), even with a key in env', () => {
    const r = migrateModelConfigRaw(
      { name: 'claude', invocation: 'cli', provider: 'anthropic', model: 'claude', binary: 'claude' },
      KEYED_ENV,
    );
    expect(r.status).toBe('disabled');
    expect(r.reason).toBe(MIGRATE_REASON.cli);
    expect(r.config?.protocol).toBe('anthropic');
  });

  it('provider google-antigravity → disabled (Gemini/Vertex removed), even if invocation api', () => {
    const r = migrateModelConfigRaw(
      { name: 'c', invocation: 'api', provider: 'google-antigravity', model: 'claude' },
      KEYED_ENV,
    );
    expect(r.status).toBe('disabled');
    expect(r.reason).toBe(MIGRATE_REASON.google);
  });

  it('provider google-vertex → disabled (Gemini/Vertex removed)', () => {
    const r = migrateModelConfigRaw(
      { name: 'gemini', invocation: 'api', provider: 'google-vertex', model: 'gemini-2.5-pro' },
      KEYED_ENV,
    );
    expect(r.status).toBe('disabled');
    expect(r.reason).toBe(MIGRATE_REASON.google);
  });

  it('provider github-copilot → disabled (Copilot removed)', () => {
    const r = migrateModelConfigRaw(
      { name: 'cop', invocation: 'api', provider: 'github-copilot', model: 'gpt-4o' },
      KEYED_ENV,
    );
    expect(r.status).toBe('disabled');
    expect(r.reason).toBe(MIGRATE_REASON.copilot);
  });

  it('unrecognised legacy shape → disabled (never throws, never drops)', () => {
    const r = migrateModelConfigRaw({ name: 'mystery', model: 'foo' }, EMPTY_ENV);
    expect(r.status).toBe('disabled');
    expect(r.reason).toBe(MIGRATE_REASON.unknown);
    expect(r.config?.name).toBe('mystery');
  });

  it('never throws on garbage input', () => {
    expect(() => migrateModelConfigRaw(null)).not.toThrow();
    expect(() => migrateModelConfigRaw(42)).not.toThrow();
    expect(() => migrateModelConfigRaw('str')).not.toThrow();
    expect(migrateModelConfigRaw(null).status).toBe('disabled');
  });

  it('carries over generation params and falls back model→name', () => {
    const r = migrateModelConfigRaw(
      {
        name: 'gpt',
        invocation: 'api',
        provider: 'openai',
        capabilities: ['code', 'analysis'],
        temperature: 0.4,
        priority: 90,
      },
      KEYED_ENV,
    );
    expect(r.config?.model).toBe('gpt'); // model missing → name
    expect(r.config?.capabilities).toEqual(['code', 'analysis']);
    expect(r.config?.temperature).toBe(0.4);
    expect(r.config?.priority).toBe(90);
  });
});

describe('migrateModelConfigRaw — idempotency', () => {
  const cases = [
    { name: 'a', invocation: 'api', provider: 'openai', model: 'gpt-5' }, // converted (with key)
    { name: 'b', invocation: 'cli', provider: 'anthropic', model: 'claude' }, // disabled cli
    { name: 'c', invocation: 'api', provider: 'google-vertex', model: 'gemini' }, // disabled google
    { name: 'd', invocation: 'api', model: 'x', api_base_url: 'http://h/v1' }, // converted custom
  ];

  for (const input of cases) {
    it(`migrating twice yields a stable result: ${input.name}`, () => {
      const once = migrateModelConfigRaw(input, KEYED_ENV);
      expect(once.config).toBeDefined();
      const twice = migrateModelConfigRaw(once.config, KEYED_ENV);
      // second pass sees a v2 object (has protocol) → ok, no further rewrite
      expect(twice.status).toBe('ok');
      expect(twice.config).toBeUndefined();
    });
  }
});

describe('migrateCouncilConfigRaw', () => {
  it('schema_version 1 → converted with schema_version 2', () => {
    const r = migrateCouncilConfigRaw({ schema_version: 1, general: {} });
    expect(r.status).toBe('converted');
    expect(r.config?.schema_version).toBe(2);
  });

  it('missing schema_version treated as v1 → converted', () => {
    const r = migrateCouncilConfigRaw({ general: {} });
    expect(r.status).toBe('converted');
    expect(r.config?.schema_version).toBe(2);
  });

  it('schema_version 2 → ok, no rewrite', () => {
    const r = migrateCouncilConfigRaw({ schema_version: 2 });
    expect(r.status).toBe('ok');
    expect(r.config).toBeUndefined();
  });

  it('never throws on garbage input', () => {
    expect(() => migrateCouncilConfigRaw(null)).not.toThrow();
    expect(migrateCouncilConfigRaw(null).status).toBe('converted');
  });
});

describe('ConfigLoader migration on load — backup + rewrite', () => {
  let testDir: string;

  function makeLoader(): ConfigLoader {
    testDir = join(tmpdir(), `council-migrate-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(testDir, 'models'), { recursive: true });
    return new ConfigLoader(testDir);
  }

  it('rewrites a v1 model file to v2 and backs up the original to .v1.bak', () => {
    const loader = makeLoader();
    const modelPath = join(testDir, 'models', 'gpt-5.yaml');
    const v1 = {
      name: 'gpt-5',
      invocation: 'cli',
      provider: 'openai',
      model: 'gpt-5',
      binary: 'codex',
      enabled: true,
    };
    writeFileSync(modelPath, stringifyYaml(v1));

    const models = loader.loadAllModelConfigs();
    expect(models).toHaveLength(1);
    // cli → disabled, but kept (non-destructive)
    expect(models[0]!.enabled).toBe(false);
    expect(models[0]!.legacy_disabled_reason).toBe(MIGRATE_REASON.cli);
    expect(models[0]!.protocol).toBe('openai');

    // original preserved as .v1.bak, primary file rewritten to v2
    const backup = `${modelPath}.v1.bak`;
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup, 'utf-8')).toContain('invocation: cli');
    const rewritten = readFileSync(modelPath, 'utf-8');
    expect(rewritten).toContain('protocol: openai');
    expect(rewritten).not.toContain('binary:');

    rmSync(testDir, { recursive: true, force: true });
  });

  it('is idempotent on disk: a second load does not re-backup or change the file', () => {
    const loader = makeLoader();
    const modelPath = join(testDir, 'models', 'm.yaml');
    writeFileSync(modelPath, stringifyYaml({ name: 'm', invocation: 'api', provider: 'google-vertex', model: 'g' }));

    loader.loadAllModelConfigs();
    const afterFirst = readFileSync(modelPath, 'utf-8');
    const backup = readFileSync(`${modelPath}.v1.bak`, 'utf-8');

    loader.loadAllModelConfigs();
    // primary file is already v2 → untouched; backup still the original v1
    expect(readFileSync(modelPath, 'utf-8')).toBe(afterFirst);
    expect(readFileSync(`${modelPath}.v1.bak`, 'utf-8')).toBe(backup);
    expect(backup).toContain('invocation: api');

    rmSync(testDir, { recursive: true, force: true });
  });

  it('migrates council.yaml schema_version 1 → 2 with backup', () => {
    const loader = makeLoader();
    const councilPath = join(testDir, 'council.yaml');
    writeFileSync(
      councilPath,
      stringifyYaml({
        schema_version: 1,
        general: { default_mode: 'debate' },
        storage: {},
        routing: { default: {} },
      }),
    );

    const cfg = loader.loadCouncilConfig();
    expect(cfg.schema_version).toBe(2);
    expect(cfg.general.default_mode).toBe('debate');
    expect(existsSync(`${councilPath}.v1.bak`)).toBe(true);
    expect(readFileSync(councilPath, 'utf-8')).toContain('schema_version: 2');

    rmSync(testDir, { recursive: true, force: true });
  });
});
