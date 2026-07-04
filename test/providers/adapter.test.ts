import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock hasBinary so the CLI-fallback path can be exercised without a real binary on PATH.
vi.mock('../../src/providers/utils.js', () => ({
  hasBinary: vi.fn(() => true),
}));

import { AutoAdapter } from '../../src/providers/adapter.js';
import type { InvocationResult, HealthStatus } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { ApiAdapter } from '../../src/providers/api-adapter.js';
import type { CliAdapter } from '../../src/providers/cli-adapter.js';
import { hasBinary } from '../../src/providers/utils.js';

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

// --------------------------------------------------------------------------
// CLI fallback param mapping — when API fails and we fall back to a CLI binary, the
// API config's generation params must be mapped ONLY to flags the binary accepts.
// codex maps reasoning_effort to a `-c model_reasoning_effort=...` override; temperature
// and max_tokens have no confident mapping and are dropped. claude maps nothing.
// --------------------------------------------------------------------------

describe('AutoAdapter — CLI fallback generation-param mapping', () => {
  const cliResult: InvocationResult = { ...okResult, invocation_mode: 'cli' };

  /** Wire an API adapter that reports healthy but fails on invoke, forcing CLI fallback. */
  function failingApi(): ApiAdapter {
    return {
      invoke: vi.fn().mockRejectedValue(new Error('api boom')),
      healthCheck: vi.fn().mockResolvedValue(healthyStatus),
    } as unknown as ApiAdapter;
  }

  /** CLI adapter that succeeds and lets us inspect the config it was handed. */
  function capturingCli(captured: { config?: ModelConfig }): CliAdapter {
    return {
      invoke: vi.fn().mockImplementation((cfg: ModelConfig) => {
        captured.config = cfg;
        return Promise.resolve(cliResult);
      }),
      healthCheck: vi.fn().mockResolvedValue(unavailableStatus),
    } as unknown as CliAdapter;
  }

  beforeEach(() => {
    vi.mocked(hasBinary).mockReturnValue(true);
  });

  it('codex: maps reasoning_effort to -c model_reasoning_effort, drops temperature/max_tokens', async () => {
    const captured: { config?: ModelConfig } = {};
    const auto = new AutoAdapter(failingApi(), capturingCli(captured));

    const config = makeConfig({
      provider: 'openai',
      model: 'gpt-5',
      reasoning_effort: 'high',
      temperature: 0.7,
      max_tokens: 4096,
    });
    const result = await auto.invoke(config, 'test');

    expect(result.invocation_mode).toBe('cli');
    const args = captured.config?.args ?? [];
    // reasoning_effort → codex config override, adjacent flag+value.
    expect(args).toContain('-c');
    expect(args).toContain('model_reasoning_effort="high"');
    const idx = args.indexOf('model_reasoning_effort="high"');
    expect(args[idx - 1]).toBe('-c');
    // temperature / max_tokens have no safe codex flag → never emitted.
    expect(args.join(' ')).not.toContain('temperature');
    expect(args.join(' ')).not.toMatch(/max.?tokens/i);
    expect(args.join(' ')).not.toContain('0.7');
    expect(args.join(' ')).not.toContain('4096');
    // base codex exec args are preserved and the prompt is appended by the CLI adapter (input_mode arg).
    expect(args.slice(0, 3)).toEqual(['exec', '-m', 'gpt-5']);
    expect(captured.config?.input_mode).toBe('arg');
  });

  it('claude: has no param flags → no generation-param args added', async () => {
    const captured: { config?: ModelConfig } = {};
    const auto = new AutoAdapter(failingApi(), capturingCli(captured));

    const config = makeConfig({
      provider: 'anthropic',
      model: 'claude-x',
      reasoning_effort: 'high',
      temperature: 0.5,
      max_tokens: 2048,
    });
    await auto.invoke(config, 'test');

    // claude fallback args are exactly the base -p --model <model>, no mapped params.
    expect(captured.config?.args).toEqual(['-p', '--model', 'claude-x']);
  });

  it('codex without reasoning_effort → no -c model_reasoning_effort override', async () => {
    const captured: { config?: ModelConfig } = {};
    const auto = new AutoAdapter(failingApi(), capturingCli(captured));

    const config = makeConfig({ provider: 'openai', model: 'gpt-5' });
    await auto.invoke(config, 'test');

    expect((captured.config?.args ?? []).join(' ')).not.toContain('model_reasoning_effort');
  });
});
