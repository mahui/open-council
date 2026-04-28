import { describe, it, expect, vi } from 'vitest';
import { generateRoles } from '../../src/core/role-generator.js';
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
});
