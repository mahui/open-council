import { describe, it, expect, afterEach } from 'vitest';
import { getModels } from '@mariozechner/pi-ai';
import type { Api, KnownProvider, Model } from '@mariozechner/pi-ai';
import { MODEL_PRESETS, presetToModelConfig, discoverModelsFromEnv } from '../../src/config/presets.js';
import { MODEL_CATALOG, catalogModelIds } from '../../src/shared/model-catalog.js';

describe('MODEL_PRESETS', () => {
  it('should have presets for all three providers', () => {
    const providers = new Set(MODEL_PRESETS.map(p => p.provider));
    expect(providers.has('anthropic')).toBe(true);
    expect(providers.has('openai')).toBe(true);
    expect(providers.has('google')).toBe(true);
  });

  it('should have both CLI and API presets', () => {
    const modes = new Set(MODEL_PRESETS.map(p => p.invocation));
    expect(modes.has('cli')).toBe(true);
    expect(modes.has('api')).toBe(true);
  });
});

describe('presetToModelConfig', () => {
  it('should convert API preset to ModelConfig', () => {
    const preset = MODEL_PRESETS.find(p => p.name === 'claude-sonnet');
    expect(preset).toBeDefined();

    const config = presetToModelConfig(preset!);
    expect(config.name).toBe('claude-sonnet');
    expect(config.provider).toBe('anthropic');
    expect(config.invocation).toBe('api');
    expect(config.enabled).toBe(true);
    expect(config.timeout_seconds).toBe(120);
  });

  it('should convert CLI preset with binary info', () => {
    const preset = MODEL_PRESETS.find(p => p.name === 'claude-cli');
    expect(preset).toBeDefined();

    const config = presetToModelConfig(preset!);
    expect(config.invocation).toBe('cli');
    expect(config.binary).toBe('claude');
    expect(config.args).toEqual(['-p']);
    expect(config.input_mode).toBe('arg');
  });
});

/**
 * Drift guard: MODEL_PRESETS, discoverModelsFromEnv, and
 * providers/model-discovery all previously hardcoded their own (diverging) model
 * IDs. They must now ALL draw from the shared catalog. These tests fail loudly
 * if a raw model-ID literal is ever reintroduced into presets.ts.
 */
describe('single-source model IDs (drift guard)', () => {
  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'] as const;
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

  it('every catalog tier ID is a real @mariozechner/pi-ai model (derived, not invented)', () => {
    for (const cat of Object.values(MODEL_CATALOG)) {
      const realIds = new Set(
        (getModels(cat.provider as KnownProvider) as Model<Api>[]).map(m => m.id),
      );
      for (const tier of [cat.flagship, cat.balanced, cat.economy]) {
        expect(realIds.has(tier.id), `${cat.provider} tier "${tier.id}" is not a known pi-ai model`).toBe(true);
      }
    }
  });

  it('every MODEL_PRESETS model ID belongs to the shared catalog', () => {
    const ids = catalogModelIds();
    for (const preset of MODEL_PRESETS) {
      expect(ids.has(preset.model), `preset "${preset.name}" uses off-catalog model "${preset.model}"`).toBe(true);
    }
  });

  it('presets map to the expected catalog tiers', () => {
    const byName = new Map(MODEL_PRESETS.map(p => [p.name, p]));
    expect(byName.get('claude-opus')?.model).toBe(MODEL_CATALOG.anthropic.flagship.id);
    expect(byName.get('claude-sonnet')?.model).toBe(MODEL_CATALOG.anthropic.balanced.id);
    expect(byName.get('claude-cli')?.model).toBe(MODEL_CATALOG.anthropic.balanced.id);
    expect(byName.get('gemini-pro')?.model).toBe(MODEL_CATALOG.google.flagship.id);
    expect(byName.get('gemini-cli')?.model).toBe(MODEL_CATALOG.google.balanced.id);
  });

  it('every discoverModelsFromEnv model ID belongs to the shared catalog', () => {
    stubEnv('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY');
    const ids = catalogModelIds();
    const models = discoverModelsFromEnv();
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(ids.has(m.model), `env model "${m.name}" uses off-catalog model "${m.model}"`).toBe(true);
    }
  });

  it('env-var API fallback uses the balanced tier for each provider', () => {
    stubEnv('ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY');
    const models = discoverModelsFromEnv();
    const byProvider = new Map(models.map(m => [m.provider, m.model]));
    expect(byProvider.get('anthropic')).toBe(MODEL_CATALOG.anthropic.balanced.id);
    expect(byProvider.get('openai')).toBe(MODEL_CATALOG.openai.balanced.id);
    expect(byProvider.get('google')).toBe(MODEL_CATALOG.google.balanced.id);
  });

  it('OAuth-credential fallback (no API key, no CLI binary) yields catalog IDs only', () => {
    stubEnv(); // no API keys
    const ids = catalogModelIds();
    const credManager = { hasCredential: (p: string): boolean => p === 'anthropic' || p === 'google' };
    const models = discoverModelsFromEnv(credManager);
    expect(models.length).toBeGreaterThan(0);
    for (const m of models) {
      expect(ids.has(m.model), `oauth-fallback model "${m.name}" uses off-catalog model "${m.model}"`).toBe(true);
    }
  });
});
