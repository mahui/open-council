/**
 * Tests for ApiAdapter — custom OpenAI-compatible endpoint branch.
 *
 * Strategy: mock @mariozechner/pi-ai and node:fs at the module level so that
 * no real network or filesystem I/O occurs. A fake CredentialManager object is
 * constructed inline for each test to keep tests fully independent (TEST-02).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --------------------------------------------------------------------------
// Module-level mocks — must be declared before any import that transitively
// pulls in the mocked modules.
// --------------------------------------------------------------------------

// Mock @mariozechner/pi-ai so streamSimple / completeSimple / getModel / getModels
// never touch a real network.
vi.mock('@mariozechner/pi-ai', () => ({
  streamSimple: vi.fn(),
  completeSimple: vi.fn(),
  getModel: vi.fn(),
  getModels: vi.fn(),
  getEnvApiKey: vi.fn(() => undefined),
}));

vi.mock('@mariozechner/pi-ai/oauth', () => ({
  getOAuthProvider: vi.fn(() => null),
  getOAuthProviders: vi.fn(() => []),
  getOAuthApiKey: vi.fn(),
}));

// Mock health module — throttle is async and we don't want real DB access in
// unit tests for api-adapter. recordSuccess / recordFailure / getProviderStatus
// are stubs.
vi.mock('../../src/providers/health.js', () => ({
  throttle: vi.fn().mockResolvedValue(undefined),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  getProviderStatus: vi.fn(() => 'healthy'),
}));

// Mock node:fs to control existsSync / readFileSync without touching disk.
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  };
});

// --------------------------------------------------------------------------
// Imports (after mocks are registered)
// --------------------------------------------------------------------------
import { ApiAdapter } from '../../src/providers/api-adapter.js';
import { InvocationError, InvocationTimeoutError } from '../../src/types/errors.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { CredentialManager } from '../../src/providers/credentials/discovery.js';
import { existsSync, readFileSync } from 'node:fs';
import { completeSimple, streamSimple } from '@mariozechner/pi-ai';

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'custom:myservice:llama3',
    invocation: 'api',
    provider: 'custom:myservice',
    model: 'llama3',
    timeout_seconds: 120,
    capabilities: ['general'],
    priority: 50,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: false,
    ...overrides,
  };
}

function makeFakeCredentialManager(overrides: Partial<CredentialManager> = {}): CredentialManager {
  return {
    discoverAll: vi.fn(),
    getApiKey: vi.fn().mockResolvedValue(''),
    hasCredential: vi.fn().mockReturnValue(false),
    getPiaiProvider: vi.fn().mockReturnValue('custom:myservice'),
    getAvailableProviders: vi.fn().mockReturnValue([]),
    getOAuthCredentials: vi.fn().mockReturnValue(undefined),
    getDirectSource: vi.fn().mockReturnValue(undefined),
    login: vi.fn(),
    getLoginableProviders: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as CredentialManager;
}

// --------------------------------------------------------------------------
// healthCheck — custom endpoint scenarios
// --------------------------------------------------------------------------

describe('ApiAdapter.healthCheck — custom OpenAI-compatible endpoint', () => {
  let credManager: CredentialManager;
  let adapter: ApiAdapter;

  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    credManager = makeFakeCredentialManager();
    adapter = new ApiAdapter(credManager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('api_base_url + api_credential_path file exists → healthy', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const config = makeConfig({
      api_base_url: 'https://api.example.com/v1',
      api_credential_path: '/home/user/.config/myservice.key',
    });

    const result = await adapter.healthCheck(config);

    expect(result.level).toBe('healthy');
    expect(result.message).toBe('credential file present');
    expect(vi.mocked(existsSync)).toHaveBeenCalledWith('/home/user/.config/myservice.key');
  });

  it('api_base_url + api_credential_path file missing → unavailable', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const config = makeConfig({
      api_base_url: 'https://api.example.com/v1',
      api_credential_path: '/home/user/.config/missing.key',
    });

    const result = await adapter.healthCheck(config);

    expect(result.level).toBe('unavailable');
    expect(result.message).toContain('/home/user/.config/missing.key');
  });

  it('api_base_url + api_key_env env var set → healthy', async () => {
    process.env['MY_SERVICE_API_KEY'] = 'sk-test-value';

    const config = makeConfig({
      api_base_url: 'https://api.example.com/v1',
      api_key_env: 'MY_SERVICE_API_KEY',
    });

    const result = await adapter.healthCheck(config);

    expect(result.level).toBe('healthy');
    expect(result.message).toContain('MY_SERVICE_API_KEY');

    delete process.env['MY_SERVICE_API_KEY'];
  });

  it('api_base_url + api_key_env not set → unavailable', async () => {
    delete process.env['MY_SERVICE_API_KEY_ABSENT'];

    const config = makeConfig({
      api_base_url: 'https://api.example.com/v1',
      api_key_env: 'MY_SERVICE_API_KEY_ABSENT',
    });

    const result = await adapter.healthCheck(config);

    expect(result.level).toBe('unavailable');
    expect(result.message).toContain('MY_SERVICE_API_KEY_ABSENT');
  });

  it('api_base_url=http://localhost:11434/v1 with no key → healthy (local no-auth)', async () => {
    const config = makeConfig({
      api_base_url: 'http://localhost:11434/v1',
      // no api_key_env, no api_credential_path
    });

    const result = await adapter.healthCheck(config);

    expect(result.level).toBe('healthy');
    expect(result.message).toContain('localhost');
  });

  it('api_base_url=http://127.0.0.1:8080/v1 with no key → healthy (loopback no-auth)', async () => {
    const config = makeConfig({
      api_base_url: 'http://127.0.0.1:8080/v1',
    });

    const result = await adapter.healthCheck(config);

    expect(result.level).toBe('healthy');
  });

  it('api_base_url=https://api.example.com with no key → unavailable', async () => {
    const config = makeConfig({
      api_base_url: 'https://api.example.com/v1',
      // no api_key_env, no api_credential_path
    });

    const result = await adapter.healthCheck(config);

    expect(result.level).toBe('unavailable');
    expect(result.message).toContain('api.example.com');
  });
});

// --------------------------------------------------------------------------
// invoke() — custom endpoint branch bypasses credentialManager.getPiaiProvider
// --------------------------------------------------------------------------

describe('ApiAdapter.invoke — custom endpoint branch', () => {
  let credManager: CredentialManager;
  let adapter: ApiAdapter;

  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
    vi.mocked(completeSimple).mockReset();

    credManager = makeFakeCredentialManager();
    adapter = new ApiAdapter(credManager);
  });

  afterEach(() => {
    delete process.env['CUSTOM_API_KEY'];
    delete process.env['ABSENT_ENV_KEY'];
    vi.restoreAllMocks();
  });

  it('api_base_url present → getPiaiProvider is never called', async () => {
    process.env['CUSTOM_API_KEY'] = 'sk-test';

    // completeSimple returns a minimal AssistantMessage
    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'hello' }],
      usage: { input: 10, output: 5 },
      errorMessage: undefined,
    } as never);

    const config = makeConfig({
      api_base_url: 'https://api.example.com/v1',
      api_key_env: 'CUSTOM_API_KEY',
    });

    const result = await adapter.invoke(config, 'Say hello');

    expect(result.response).toBe('hello');
    expect(result.invocation_mode).toBe('api');
    expect(credManager.getPiaiProvider).not.toHaveBeenCalled();
  });

  it('api_key_env priority: env var value is passed as apiKey to completeSimple', async () => {
    process.env['CUSTOM_API_KEY'] = 'sk-env-key-value';

    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input: 5, output: 2 },
      errorMessage: undefined,
    } as never);

    const config = makeConfig({
      api_base_url: 'https://api.example.com/v1',
      api_key_env: 'CUSTOM_API_KEY',
    });

    await adapter.invoke(config, 'test prompt');

    const callArgs = vi.mocked(completeSimple).mock.calls[0];
    expect(callArgs).toBeDefined();
    // Third argument is the options object containing apiKey
    const opts = callArgs![2] as { apiKey: string };
    expect(opts.apiKey).toBe('sk-env-key-value');
  });
});

// --------------------------------------------------------------------------
// resolveApiKey — error paths
// --------------------------------------------------------------------------

describe('ApiAdapter.resolveApiKey — error paths (tested via invoke)', () => {
  let credManager: CredentialManager;
  let adapter: ApiAdapter;

  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
    credManager = makeFakeCredentialManager();
    adapter = new ApiAdapter(credManager);
  });

  afterEach(() => {
    delete process.env['ABSENT_ENV_KEY'];
    vi.restoreAllMocks();
  });

  it('api_key_env points to unset env var → throws InvocationError', async () => {
    delete process.env['ABSENT_ENV_KEY'];

    const config = makeConfig({
      api_base_url: 'https://api.example.com/v1',
      api_key_env: 'ABSENT_ENV_KEY',
    });

    await expect(adapter.invoke(config, 'prompt')).rejects.toThrow(InvocationError);
    await expect(adapter.invoke(config, 'prompt')).rejects.toThrow(/ABSENT_ENV_KEY/);
  });

  it('api_credential_path file does not exist → throws InvocationError', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockImplementation((_path: unknown) => {
      throw new Error('ENOENT: no such file or directory');
    });

    const config = makeConfig({
      api_base_url: 'https://api.example.com/v1',
      api_credential_path: '/nonexistent/path/key.txt',
    });

    await expect(adapter.invoke(config, 'prompt')).rejects.toThrow(InvocationError);
    await expect(adapter.invoke(config, 'prompt')).rejects.toThrow(/api_credential_path/);
  });

  it('api_credential_path file exists → key is read and passed to completeSimple', async () => {
    vi.mocked(readFileSync).mockReturnValue('sk-from-file\n' as never);

    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'response text' }],
      usage: { input: 3, output: 4 },
      errorMessage: undefined,
    } as never);

    const config = makeConfig({
      api_base_url: 'https://api.example.com/v1',
      api_credential_path: '/home/user/.config/myservice.key',
    });

    await adapter.invoke(config, 'prompt');

    const callArgs = vi.mocked(completeSimple).mock.calls[0];
    const opts = callArgs![2] as { apiKey: string };
    // readFileSync returns 'sk-from-file\n', which gets .trim()'d → 'sk-from-file'
    expect(opts.apiKey).toBe('sk-from-file');
  });
});

// --------------------------------------------------------------------------
// Timeout guard — a hung (never-settling) call must not hang the whole debate.
// Uses fake timers so no test actually waits; asserts the call rejects with a
// recognisable timeout error and that no timer is leaked afterwards.
// --------------------------------------------------------------------------

describe('ApiAdapter.invoke — timeout guard', () => {
  let credManager: CredentialManager;
  let adapter: ApiAdapter;

  beforeEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
    vi.mocked(completeSimple).mockReset();
    vi.mocked(streamSimple).mockReset();
    credManager = makeFakeCredentialManager();
    adapter = new ApiAdapter(credManager);
    process.env['CUSTOM_API_KEY'] = 'sk-test';
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env['CUSTOM_API_KEY'];
    vi.restoreAllMocks();
  });

  function timeoutConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
    return makeConfig({
      api_base_url: 'https://api.example.com/v1',
      api_key_env: 'CUSTOM_API_KEY',
      ...overrides,
    });
  }

  it('completeSimple that never resolves → rejects with InvocationTimeoutError, timer cleared', async () => {
    vi.useFakeTimers();
    // A promise that never settles — the classic "hung provider" scenario.
    vi.mocked(completeSimple).mockReturnValue(new Promise(() => {}) as never);

    const config = timeoutConfig({ timeout_seconds: 30 });
    const captured = adapter.invoke(config, 'prompt').then(
      () => { throw new Error('invoke should not resolve on a hung call'); },
      (e: unknown) => e,
    );

    // Just before the deadline: still pending, timer still armed.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Cross the deadline → the guard aborts and rejects.
    await vi.advanceTimersByTimeAsync(2_000);
    const err = await captured;

    expect(err).toBeInstanceOf(InvocationTimeoutError);
    expect((err as Error).message).toMatch(/timeout/i);
    expect((err as Error).message).toContain('30s');
    // No leaked timer — dispose() ran in the finally block.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes an AbortSignal to completeSimple and aborts it on timeout', async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    vi.mocked(completeSimple).mockImplementation(((_m: unknown, _c: unknown, opts: { signal?: AbortSignal }) => {
      capturedSignal = opts.signal;
      return new Promise(() => {});
    }) as never);

    const config = timeoutConfig({ timeout_seconds: 15 });
    const captured = adapter.invoke(config, 'prompt').then(() => undefined, (e: unknown) => e);

    await vi.advanceTimersByTimeAsync(16_000);
    await captured;

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(true);
  });

  it('streaming stream that never yields → rejects with timeout (idle), no chunks, timer cleared', async () => {
    vi.useFakeTimers();
    const neverStream = {
      [Symbol.asyncIterator]() {
        return { next: (): Promise<never> => new Promise(() => {}) };
      },
      result: (): Promise<never> => new Promise(() => {}),
    };
    vi.mocked(streamSimple).mockReturnValue(neverStream as never);

    const config = timeoutConfig({ timeout_seconds: 60 });
    const onChunk = vi.fn();
    const captured = adapter.invoke(config, 'prompt', onChunk).then(
      () => { throw new Error('streaming invoke should not resolve on a hung stream'); },
      (e: unknown) => e,
    );

    await vi.advanceTimersByTimeAsync(60_001);
    const err = await captured;

    expect(err).toBeInstanceOf(InvocationTimeoutError);
    expect((err as Error).message).toMatch(/timeout/i);
    expect(onChunk).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('streaming idle timer resets on each chunk; only trips after the stream stalls', async () => {
    vi.useFakeTimers();
    const events = [
      { type: 'text_delta', delta: 'a' },
      { type: 'text_delta', delta: 'b' },
    ];
    const stream = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next: (): Promise<IteratorResult<unknown>> => {
            if (i < events.length) {
              return Promise.resolve({ value: events[i++], done: false });
            }
            return new Promise(() => {}); // stall after the last chunk
          },
        };
      },
      result: (): Promise<never> => new Promise(() => {}),
    };
    vi.mocked(streamSimple).mockReturnValue(stream as never);

    const config = timeoutConfig({ timeout_seconds: 10 });
    const chunks: string[] = [];
    const captured = adapter.invoke(config, 'prompt', (c) => chunks.push(c)).then(
      () => { throw new Error('should not resolve') },
      (e: unknown) => e,
    );

    // Both chunks are delivered on flush (resetting the idle timer each time);
    // the stall then begins, so one advance past the idle window trips timeout.
    await vi.advanceTimersByTimeAsync(11_000);
    const err = await captured;

    expect(chunks).toEqual(['a', 'b']);
    expect(err).toBeInstanceOf(InvocationTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defaults to 120s when timeout_seconds is omitted', async () => {
    vi.useFakeTimers();
    vi.mocked(completeSimple).mockReturnValue(new Promise(() => {}) as never);

    // Build a config object without timeout_seconds (bypass the schema default).
    const base = timeoutConfig();
    const config = { ...base } as Partial<ModelConfig> & { timeout_seconds?: number };
    delete config.timeout_seconds;

    const captured = adapter.invoke(config as ModelConfig, 'prompt').then(
      () => undefined,
      (e: unknown) => e,
    );

    // At 119s still pending — proves the default is not lower than 120s.
    await vi.advanceTimersByTimeAsync(119_000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(2_000);
    const err = await captured;
    expect(err).toBeInstanceOf(InvocationTimeoutError);
    expect((err as Error).message).toContain('120s');
  });
});
