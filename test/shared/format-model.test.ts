/**
 * Tests for the unified model-line formatter in src/shared/format-model.ts,
 * shared by `council models`, the REPL and the setup wizard so every surface
 * renders a model the same way. Pure, zero-dependency — no mocking, no I/O.
 */
import { describe, it, expect } from 'vitest';
import { formatModelLine } from '../../src/shared/format-model.js';
import type { ModelConfig } from '../../src/types/config.js';

/** Minimal ModelConfig — formatModelLine only reads name/provider/model/protocol. */
function makeModel(overrides: Partial<ModelConfig> & { name: string; protocol: ModelConfig['protocol'] }): ModelConfig {
  return overrides as ModelConfig;
}

describe('formatModelLine — basic shape', () => {
  it('joins name, provider/model, and [protocol] with double-space separators', () => {
    const m = makeModel({ name: 'gpt-4o', protocol: 'openai', provider: 'openai', model: 'gpt-4o' });
    expect(formatModelLine(m)).toBe('gpt-4o  openai/gpt-4o  [openai]');
  });

  it('a custom-endpoint model shows its provider label as-is', () => {
    const m = makeModel({ name: 'custom:ollama:llama3.2', protocol: 'openai', provider: 'custom:ollama', model: 'llama3.2' });
    expect(formatModelLine(m)).toBe('custom:ollama:llama3.2  custom:ollama/llama3.2  [openai]');
  });
});

describe('formatModelLine — defaults for missing optional fields', () => {
  it('provider defaults to "custom" when absent', () => {
    const m = makeModel({ name: 'mystery', protocol: 'anthropic', model: 'claude-x' });
    expect(formatModelLine(m)).toBe('mystery  custom/claude-x  [anthropic]');
  });

  it('model defaults to "—" when absent', () => {
    const m = makeModel({ name: 'no-model', protocol: 'anthropic', provider: 'anthropic' });
    expect(formatModelLine(m)).toBe('no-model  anthropic/—  [anthropic]');
  });

  it('both provider and model absent → both defaults apply', () => {
    const m = makeModel({ name: 'bare', protocol: 'openai' });
    expect(formatModelLine(m)).toBe('bare  custom/—  [openai]');
  });
});

describe('formatModelLine — options', () => {
  it('chairman:true appends the chairman marker', () => {
    const m = makeModel({ name: 'gpt-4o', protocol: 'openai', provider: 'openai', model: 'gpt-4o' });
    expect(formatModelLine(m, { chairman: true })).toBe('gpt-4o  openai/gpt-4o  [openai]  (chairman⭐)');
  });

  it('chairman:false (or omitted) never appends the marker', () => {
    const m = makeModel({ name: 'gpt-4o', protocol: 'openai', provider: 'openai', model: 'gpt-4o' });
    expect(formatModelLine(m, { chairman: false })).not.toContain('chairman');
    expect(formatModelLine(m)).not.toContain('chairman');
  });

  it('nameWidth pads the name column for table alignment', () => {
    const m = makeModel({ name: 'a', protocol: 'openai', provider: 'openai', model: 'gpt-4o' });
    expect(formatModelLine(m, { nameWidth: 5 })).toBe('a      openai/gpt-4o  [openai]');
  });

  it('nameWidth shorter than the actual name has no effect (padEnd is a no-op)', () => {
    const m = makeModel({ name: 'a-very-long-model-name', protocol: 'openai', provider: 'openai', model: 'gpt-4o' });
    expect(formatModelLine(m, { nameWidth: 3 })).toBe('a-very-long-model-name  openai/gpt-4o  [openai]');
  });

  it('nameWidth and chairman combine', () => {
    const m = makeModel({ name: 'a', protocol: 'openai', provider: 'openai', model: 'gpt-4o' });
    expect(formatModelLine(m, { nameWidth: 3, chairman: true })).toBe('a    openai/gpt-4o  [openai]  (chairman⭐)');
  });
});
