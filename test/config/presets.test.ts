/**
 * Tests for src/config/presets.ts after the standard-API convergence: only the
 * two official line protocols (anthropic, openai) remain — no CLI presets, no
 * google/OAuth fallback, no pi-ai registry cross-check. Model IDs are drawn
 * from the shared catalog (src/shared/model-catalog.ts), the single source of
 * truth also used by providers/model-discovery.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { MODEL_PRESETS, presetToModelConfig, discoverModelsFromEnv } from '../../src/config/presets.js';
import { MODEL_CATALOG, catalogModelIds } from '../../src/shared/model-catalog.js';

describe('MODEL_PRESETS', () => {
  it('has presets for both official protocols, no others', () => {
    const protocols = new Set(MODEL_PRESETS.map((p) => p.protocol));
    expect(protocols).toEqual(new Set(['anthropic', 'openai']));
  });

  it('every preset carries a protocol-matched api_key_env from the shared catalog', () => {
    for (const preset of MODEL_PRESETS) {
      expect(preset.api_key_env).toBe(MODEL_CATALOG[preset.protocol].apiKeyEnv);
    }
  });

  it('every preset model id belongs to the shared catalog (drift guard)', () => {
    const ids = catalogModelIds();
    for (const preset of MODEL_PRESETS) {
      expect(ids.has(preset.model), `preset "${preset.name}" uses off-catalog model "${preset.model}"`).toBe(true);
    }
  });

  it('presets map to the expected catalog tiers', () => {
    const byName = new Map(MODEL_PRESETS.map((p) => [p.name, p]));
    expect(byName.get('claude-opus')?.model).toBe(MODEL_CATALOG.anthropic.flagship.id);
    expect(byName.get('claude-sonnet')?.model).toBe(MODEL_CATALOG.anthropic.balanced.id);
    expect(byName.get('gpt-flagship')?.model).toBe(MODEL_CATALOG.openai.flagship.id);
    expect(byName.get('gpt-mini')?.model).toBe(MODEL_CATALOG.openai.balanced.id);
  });
});

describe('presetToModelConfig', () => {
  it('converts a preset into a fully-shaped, enabled ModelConfig', () => {
    const preset = MODEL_PRESETS.find((p) => p.name === 'claude-sonnet');
    expect(preset).toBeDefined();

    const config = presetToModelConfig(preset!);
    expect(config.name).toBe('claude-sonnet');
    expect(config.protocol).toBe('anthropic');
    expect(config.provider).toBe('anthropic');
    expect(config.model).toBe(MODEL_CATALOG.anthropic.balanced.id);
    expect(config.api_key_env).toBe('ANTHROPIC_API_KEY');
    expect(config.enabled).toBe(true);
    expect(config.timeout_seconds).toBe(120);
    // No CLI-era fields survive.
    expect((config as Record<string, unknown>)['invocation']).toBeUndefined();
    expect((config as Record<string, unknown>)['binary']).toBeUndefined();
  });

  it('converts an OpenAI preset equivalently', () => {
    const preset = MODEL_PRESETS.find((p) => p.name === 'gpt-mini');
    const config = presetToModelConfig(preset!);
    expect(config.protocol).toBe('openai');
    expect(config.api_key_env).toBe('OPENAI_API_KEY');
  });
});

describe('discoverModelsFromEnv — env-var-only fallback (no CLI, no OAuth, no google)', () => {
  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const;
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
      delete savedEnv[k];
    }
  });

  function stubEnv(...keys: string[]): void {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    for (const k of keys) process.env[k] = 'test-key';
  }

  it('no env keys set → empty result', () => {
    stubEnv();
    expect(discoverModelsFromEnv()).toEqual([]);
  });

  it('ANTHROPIC_API_KEY set → the balanced-tier Anthropic model, priority 100', () => {
    stubEnv('ANTHROPIC_API_KEY');
    const models = discoverModelsFromEnv();
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe('claude-sonnet');
    expect(models[0]?.protocol).toBe('anthropic');
    expect(models[0]?.model).toBe(MODEL_CATALOG.anthropic.balanced.id);
    expect(models[0]?.priority).toBe(100);
    expect(models[0]?.api_key_env).toBe('ANTHROPIC_API_KEY');
  });

  it('OPENAI_API_KEY set → the balanced-tier OpenAI model, priority 90', () => {
    stubEnv('OPENAI_API_KEY');
    const models = discoverModelsFromEnv();
    expect(models).toHaveLength(1);
    expect(models[0]?.name).toBe('gpt-mini');
    expect(models[0]?.protocol).toBe('openai');
    expect(models[0]?.model).toBe(MODEL_CATALOG.openai.balanced.id);
    expect(models[0]?.priority).toBe(90);
  });

  it('both keys set → both models, every id belongs to the shared catalog', () => {
    stubEnv('ANTHROPIC_API_KEY', 'OPENAI_API_KEY');
    const ids = catalogModelIds();
    const models = discoverModelsFromEnv();
    expect(models).toHaveLength(2);
    for (const m of models) {
      expect(ids.has(m.model), `env model "${m.name}" uses off-catalog model "${m.model}"`).toBe(true);
    }
  });

  it('an empty-string env var value does not count as configured', () => {
    stubEnv();
    process.env['ANTHROPIC_API_KEY'] = '';
    expect(discoverModelsFromEnv()).toEqual([]);
  });
});
