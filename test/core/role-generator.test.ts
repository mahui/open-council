import { describe, it, expect, vi } from 'vitest';
import { generateRoles, resolveModel, type GeneratedRole } from '../../src/core/role-generator.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { InvocationAdapter, InvocationResult } from '../../src/types/provider.js';

const model = (name: string): ModelConfig => ({
  name,
  invocation: 'api',
  provider: 'anthropic',
  model: name,
  timeout_seconds: 30,
  capabilities: ['general'],
  priority: 50,
  max_concurrent: 1,
  resource_weight: 1,
  enabled: true,
  streaming: true,
});

function adapterReturning(roleCount: number): InvocationAdapter {
  const roles = Array.from({ length: roleCount }, (_, i) => ({
    name: `Role ${i + 1}`,
    icon: '🤖',
    description: `desc ${i + 1}`,
    system_prompt: `prompt ${i + 1}`,
    assigned_model: 'm1',
  }));
  const result: InvocationResult = {
    response: JSON.stringify(roles),
    invocation_mode: 'api',
    elapsed_ms: 10,
    timed_out: false,
    token_usage: { input_tokens: 0, output_tokens: 0 },
  };
  return {
    invoke: vi.fn().mockResolvedValue(result),
    healthCheck: vi.fn().mockResolvedValue({ level: 'healthy', message: '', checked_at: '' }),
  };
}

describe('generateRoles — agent count range', () => {
  const models = [model('m1'), model('m2'), model('m3'), model('m4'), model('m5')];

  it('honors LLM count when within [min, max]', async () => {
    const adapter = adapterReturning(3);
    const roles = await generateRoles('q', { min: 2, max: 5 }, adapter, models);
    expect(roles.length).toBe(3);
  });

  it('clamps to max when LLM returns too many', async () => {
    const adapter = adapterReturning(7);
    const roles = await generateRoles('q', { min: 2, max: 4 }, adapter, models);
    expect(roles.length).toBe(4);
  });

  it('pads to min when LLM returns too few', async () => {
    const adapter = adapterReturning(1);
    const roles = await generateRoles('q', { min: 3, max: 5 }, adapter, models);
    expect(roles.length).toBe(3);
  });

  it('respects fixed range {min:N, max:N}', async () => {
    const adapter = adapterReturning(1);
    const roles = await generateRoles('q', { min: 1, max: 1 }, adapter, models);
    expect(roles.length).toBe(1);
  });

  it('falls back to defaults when LLM fails', async () => {
    const failing: InvocationAdapter = {
      invoke: vi.fn().mockRejectedValue(new Error('boom')),
      healthCheck: vi.fn().mockResolvedValue({ level: 'healthy', message: '', checked_at: '' }),
    };
    const roles = await generateRoles('q', { min: 2, max: 5 }, failing, models);
    expect(roles.length).toBe(2);
  });

  it('fuzzy-resolves an assigned_model that only partially matches a model name', async () => {
    // 'm' is not an exact model name, but every model name (m1..m5) *contains* it,
    // so the parser's internal fuzzy match should accept the first candidate.
    const roles = [{
      name: 'Fuzzy Role', icon: '🤖', description: 'd', system_prompt: 'p', assigned_model: 'm',
    }];
    const adapter: InvocationAdapter = {
      invoke: vi.fn().mockResolvedValue({
        response: JSON.stringify(roles), invocation_mode: 'api', elapsed_ms: 1, timed_out: false,
        token_usage: { input_tokens: 0, output_tokens: 0 },
      } satisfies InvocationResult),
      healthCheck: vi.fn().mockResolvedValue({ level: 'healthy', message: '', checked_at: '' }),
    };
    const result = await generateRoles('q', { min: 1, max: 1 }, adapter, models);
    expect(models.map(m => m.name)).toContain(result[0]!.assigned_model);
  });

  it('round-robin assigns a model when assigned_model matches nothing at all', async () => {
    const roles = [
      { name: 'Role A', icon: '🤖', description: 'd', system_prompt: 'p', assigned_model: 'totally-unknown-xyz' },
      { name: 'Role B', icon: '🤖', description: 'd', system_prompt: 'p', assigned_model: 'also-unknown-xyz' },
    ];
    const adapter: InvocationAdapter = {
      invoke: vi.fn().mockResolvedValue({
        response: JSON.stringify(roles), invocation_mode: 'api', elapsed_ms: 1, timed_out: false,
        token_usage: { input_tokens: 0, output_tokens: 0 },
      } satisfies InvocationResult),
      healthCheck: vi.fn().mockResolvedValue({ level: 'healthy', message: '', checked_at: '' }),
    };
    const result = await generateRoles('q', { min: 2, max: 2 }, adapter, models);
    expect(result).toHaveLength(2);
    for (const role of result) {
      expect(models.map(m => m.name)).toContain(role.assigned_model);
    }
  });

  it('falls back to defaults when the LLM response is malformed JSON', async () => {
    // Matches the `\[[\s\S]*\]` extraction regex but is not valid JSON (unquoted value).
    const adapter: InvocationAdapter = {
      invoke: vi.fn().mockResolvedValue({
        response: '[{"name": "A", "system_prompt": unquoted_value}]',
        invocation_mode: 'api', elapsed_ms: 1, timed_out: false,
        token_usage: { input_tokens: 0, output_tokens: 0 },
      } satisfies InvocationResult),
      healthCheck: vi.fn().mockResolvedValue({ level: 'healthy', message: '', checked_at: '' }),
    };
    const roles = await generateRoles('q', { min: 2, max: 5 }, adapter, models);
    // Falls through to defaultRoles(min, models) — same shape as the reject-path test.
    expect(roles.length).toBe(2);
  });
});

describe('resolveModel', () => {
  const models = [model('claude'), model('gemini'), model('gpt')];

  function role(assigned_model: string): GeneratedRole {
    return { name: 'Analyst', icon: '🔍', description: 'd', system_prompt: 'p', assigned_model };
  }

  it('resolves an exact model name match', () => {
    expect(resolveModel(role('gemini'), models).name).toBe('gemini');
  });

  it('fuzzy-resolves via the model id field', () => {
    const withId = [{ ...model('assistant'), model: 'claude-sonnet-4' }];
    expect(resolveModel(role('claude-sonnet-4'), withId).name).toBe('assistant');
  });

  it('fuzzy-resolves when the assigned_model is a substring of the model name', () => {
    expect(resolveModel(role('gem'), models).name).toBe('gemini');
  });

  it('falls back to the first model when nothing matches at all', () => {
    expect(resolveModel(role('nonexistent-xyz'), models).name).toBe('claude');
  });
});
