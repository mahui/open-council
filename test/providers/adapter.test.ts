import { describe, it, expect, vi } from 'vitest';
import { AutoAdapter } from '../../src/providers/adapter.js';
import type { InvocationResult, HealthStatus } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { ApiAdapter } from '../../src/providers/api-adapter.js';
import type { CliAdapter } from '../../src/providers/cli-adapter.js';

function makeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'test-model',
    invocation: 'auto',
    provider: 'anthropic',
    model: 'test',
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

const okResult: InvocationResult = {
  response: 'Hello',
  elapsed_ms: 100,
  invocation_mode: 'api',
  http_status: 200,
  timed_out: false,
};

const healthyStatus: HealthStatus = {
  level: 'healthy',
  message: 'OK',
  checked_at: new Date().toISOString(),
};

const unavailableStatus: HealthStatus = {
  level: 'unavailable',
  message: 'Not available',
  checked_at: new Date().toISOString(),
};

describe('AutoAdapter', () => {
  it('should prefer API mode when healthy', async () => {
    const apiAdapter = {
      invoke: vi.fn().mockResolvedValue(okResult),
      healthCheck: vi.fn().mockResolvedValue(healthyStatus),
    } as unknown as ApiAdapter;

    const cliAdapter = {
      invoke: vi.fn(),
      healthCheck: vi.fn(),
    } as unknown as CliAdapter;

    const auto = new AutoAdapter(apiAdapter, cliAdapter);
    const result = await auto.invoke(makeConfig(), 'test');

    expect(result.invocation_mode).toBe('api');
    expect(apiAdapter.invoke).toHaveBeenCalled();
    expect(cliAdapter.invoke).not.toHaveBeenCalled();
  });

  it('should fall back to CLI when API unavailable', async () => {
    const cliResult = { ...okResult, invocation_mode: 'cli' as const };
    const apiAdapter = {
      invoke: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(unavailableStatus),
    } as unknown as ApiAdapter;

    const cliAdapter = {
      invoke: vi.fn().mockResolvedValue(cliResult),
      healthCheck: vi.fn().mockResolvedValue(healthyStatus),
    } as unknown as CliAdapter;

    const auto = new AutoAdapter(apiAdapter, cliAdapter);
    const result = await auto.invoke(makeConfig(), 'test');

    expect(result.invocation_mode).toBe('cli');
    expect(cliAdapter.invoke).toHaveBeenCalled();
  });

  it('should throw when both modes unavailable', async () => {
    const apiAdapter = {
      invoke: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(unavailableStatus),
    } as unknown as ApiAdapter;

    const cliAdapter = {
      invoke: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue(unavailableStatus),
    } as unknown as CliAdapter;

    const auto = new AutoAdapter(apiAdapter, cliAdapter);
    await expect(auto.invoke(makeConfig(), 'test')).rejects.toThrow('No available invocation mode');
  });

  it('should use only API when invocation is api', async () => {
    const apiAdapter = {
      invoke: vi.fn().mockResolvedValue(okResult),
      healthCheck: vi.fn().mockResolvedValue(healthyStatus),
    } as unknown as ApiAdapter;

    const cliAdapter = {
      invoke: vi.fn(),
      healthCheck: vi.fn(),
    } as unknown as CliAdapter;

    const auto = new AutoAdapter(apiAdapter, cliAdapter);
    const config = makeConfig({ invocation: 'api' });
    await auto.invoke(config, 'test');

    expect(apiAdapter.invoke).toHaveBeenCalled();
  });
});
