import { describe, it, expect } from 'vitest';
import { MODEL_PRESETS, presetToModelConfig } from '../../src/config/presets.js';

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
