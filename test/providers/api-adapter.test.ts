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
import { completeSimple, streamSimple, getModel, getModels } from '@mariozechner/pi-ai';
import { recordFailure, recordSuccess } from '../../src/providers/health.js';

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

// --------------------------------------------------------------------------
// Retry + error classification — a transient failure is retried with backoff,
// a permanent failure is not, and only exhausted/permanent failures are reported
// to the circuit breaker. Uses an injected `sleep` so no test actually waits and
// the backoff rhythm can be asserted exactly.
// --------------------------------------------------------------------------

describe('ApiAdapter.invoke — retry + error classification', () => {
  let credManager: CredentialManager;
  let sleepDelays: number[];
  let adapter: ApiAdapter;

  const successMessage = {
    stopReason: 'stop',
    content: [{ type: 'text', text: 'ok' }],
    usage: { input: 3, output: 4 },
    errorMessage: undefined,
  };

  function errorMessage(text: string): unknown {
    // Shape pi-ai returns on an API failure: stopReason 'error' + errorMessage. invokeComplete
    // turns this into an InvocationError whose message embeds `text`, which classifyError reads.
    return { stopReason: 'error', content: [], usage: { input: 0, output: 0 }, errorMessage: text };
  }

  function retryConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
    return makeConfig({
      api_base_url: 'https://api.example.com/v1',
      api_key_env: 'CUSTOM_API_KEY',
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.mocked(completeSimple).mockReset();
    vi.mocked(recordFailure).mockReset();
    vi.mocked(recordSuccess).mockReset();
    sleepDelays = [];
    credManager = makeFakeCredentialManager();
    // Inject a synchronous sleep that records the requested delay instead of waiting.
    adapter = new ApiAdapter(credManager, {
      sleep: async (ms: number) => { sleepDelays.push(ms); },
    });
    process.env['CUSTOM_API_KEY'] = 'sk-test';
  });

  afterEach(() => {
    delete process.env['CUSTOM_API_KEY'];
    vi.restoreAllMocks();
  });

  it('503 then success → retried once, resolves, no failure recorded', async () => {
    vi.mocked(completeSimple)
      .mockResolvedValueOnce(errorMessage('503 service unavailable') as never)
      .mockResolvedValueOnce(successMessage as never);

    const result = await adapter.invoke(retryConfig(), 'prompt');

    expect(result.response).toBe('ok');
    expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(2);
    expect(sleepDelays).toHaveLength(1);
    // First backoff ~1s (base 1000 + up to 25% jitter).
    expect(sleepDelays[0]).toBeGreaterThanOrEqual(1000);
    expect(sleepDelays[0]).toBeLessThan(1250);
    // A retry that ultimately succeeded must not touch the circuit breaker.
    expect(vi.mocked(recordFailure)).not.toHaveBeenCalled();
    expect(vi.mocked(recordSuccess)).toHaveBeenCalledTimes(1);
  });

  it('403 forbidden → not retried, fails immediately, recorded as permanent', async () => {
    vi.mocked(completeSimple).mockResolvedValue(errorMessage('403 forbidden') as never);

    await expect(adapter.invoke(retryConfig(), 'prompt')).rejects.toThrow(InvocationError);

    expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
    expect(sleepDelays).toHaveLength(0);
    expect(vi.mocked(recordFailure)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordFailure)).toHaveBeenCalledWith('custom:myservice', 'permanent', false);
  });

  it('retry rhythm: two 503s then success → backoff ~1s then ~4s (exponential)', async () => {
    vi.mocked(completeSimple)
      .mockResolvedValueOnce(errorMessage('503 unavailable') as never)
      .mockResolvedValueOnce(errorMessage('503 unavailable') as never)
      .mockResolvedValueOnce(successMessage as never);

    const result = await adapter.invoke(retryConfig(), 'prompt');

    expect(result.response).toBe('ok');
    expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(3);
    expect(sleepDelays).toHaveLength(2);
    // Exponential base-4 backoff with jitter: ~1s then ~4s.
    expect(sleepDelays[0]).toBeGreaterThanOrEqual(1000);
    expect(sleepDelays[0]).toBeLessThan(1250);
    expect(sleepDelays[1]).toBeGreaterThanOrEqual(4000);
    expect(sleepDelays[1]).toBeLessThan(5000);
    expect(vi.mocked(recordFailure)).not.toHaveBeenCalled();
  });

  it('persistent 503 → retries exhausted (2), then recorded as retryable failure', async () => {
    vi.mocked(completeSimple).mockResolvedValue(errorMessage('503 unavailable') as never);

    await expect(adapter.invoke(retryConfig(), 'prompt')).rejects.toThrow(InvocationError);

    // Initial attempt + 2 retries = 3 calls.
    expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(3);
    expect(sleepDelays).toHaveLength(2);
    expect(vi.mocked(recordFailure)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordFailure)).toHaveBeenCalledWith('custom:myservice', 'retryable', false);
  });

  it('429 rate limit → retried, and on exhaustion recorded with rateLimited=true', async () => {
    vi.mocked(completeSimple).mockResolvedValue(errorMessage('429 rate limit exceeded') as never);

    await expect(adapter.invoke(retryConfig(), 'prompt')).rejects.toThrow(InvocationError);

    expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(recordFailure)).toHaveBeenCalledWith('custom:myservice', 'retryable', true);
  });
});

// --------------------------------------------------------------------------
// Truncation detection — pi-ai StopReason 'length' means the model hit the
// max_tokens ceiling. The content is still real and must be returned; the
// result is flagged truncated=true so the orchestrator can surface it.
// --------------------------------------------------------------------------

describe('ApiAdapter.invoke — truncation detection (stopReason length)', () => {
  let credManager: CredentialManager;
  let adapter: ApiAdapter;

  function truncConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
    return makeConfig({
      api_base_url: 'https://api.example.com/v1',
      api_key_env: 'CUSTOM_API_KEY',
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.mocked(completeSimple).mockReset();
    vi.mocked(streamSimple).mockReset();
    credManager = makeFakeCredentialManager();
    adapter = new ApiAdapter(credManager);
    process.env['CUSTOM_API_KEY'] = 'sk-test';
  });

  afterEach(() => {
    delete process.env['CUSTOM_API_KEY'];
    vi.restoreAllMocks();
  });

  it('complete: stopReason "length" → truncated=true and content preserved', async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: 'length',
      content: [{ type: 'text', text: 'partial but useful answer' }],
      usage: { input: 10, output: 8192 },
      errorMessage: undefined,
    } as never);

    const result = await adapter.invoke(truncConfig(), 'prompt');

    expect(result.truncated).toBe(true);
    expect(result.response).toBe('partial but useful answer');
    expect(result.timed_out).toBe(false);
  });

  it('complete: stopReason "stop" → truncated=false', async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'complete answer' }],
      usage: { input: 10, output: 20 },
      errorMessage: undefined,
    } as never);

    const result = await adapter.invoke(truncConfig(), 'prompt');

    expect(result.truncated).toBe(false);
    expect(result.response).toBe('complete answer');
  });

  it('streaming: stopReason "length" → truncated=true and streamed content preserved', async () => {
    const events = [
      { type: 'text_delta', delta: 'chunk-1 ' },
      { type: 'text_delta', delta: 'chunk-2' },
    ];
    const stream = {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
      result: (): Promise<unknown> => Promise.resolve({
        stopReason: 'length',
        content: [{ type: 'text', text: 'chunk-1 chunk-2' }],
        usage: { input: 5, output: 8192 },
        errorMessage: undefined,
      }),
    };
    vi.mocked(streamSimple).mockReturnValue(stream as never);

    const chunks: string[] = [];
    const result = await adapter.invoke(
      truncConfig({ streaming: true }),
      'prompt',
      (c) => chunks.push(c),
    );

    expect(result.truncated).toBe(true);
    expect(result.response).toBe('chunk-1 chunk-2');
    expect(chunks).toEqual(['chunk-1 ', 'chunk-2']);
  });
});

// --------------------------------------------------------------------------
// max_tokens default tiering — the request-side default scales with reasoning
// effort (no reasoning → 8192, minimal/low/medium → 16384, high+ → 32768).
// An explicit config.max_tokens always overrides the tiered default.
// --------------------------------------------------------------------------

describe('ApiAdapter.invoke — reasoning-tiered max_tokens default', () => {
  let credManager: CredentialManager;
  let adapter: ApiAdapter;

  function tierConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
    return makeConfig({
      api_base_url: 'https://api.example.com/v1',
      api_key_env: 'CUSTOM_API_KEY',
      ...overrides,
    });
  }

  function lastMaxTokens(): number {
    const callArgs = vi.mocked(completeSimple).mock.calls[0];
    const opts = callArgs![2] as { maxTokens: number };
    return opts.maxTokens;
  }

  beforeEach(() => {
    vi.mocked(completeSimple).mockReset();
    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input: 1, output: 1 },
      errorMessage: undefined,
    } as never);
    credManager = makeFakeCredentialManager();
    adapter = new ApiAdapter(credManager);
    process.env['CUSTOM_API_KEY'] = 'sk-test';
  });

  afterEach(() => {
    delete process.env['CUSTOM_API_KEY'];
    vi.restoreAllMocks();
  });

  it('no reasoning_effort → default 8192', async () => {
    const config = tierConfig();
    delete (config as Partial<ModelConfig>).reasoning_effort;
    await adapter.invoke(config, 'prompt');
    expect(lastMaxTokens()).toBe(8192);
  });

  it('reasoning_effort "low" → default 16384', async () => {
    await adapter.invoke(tierConfig({ reasoning_effort: 'low' }), 'prompt');
    expect(lastMaxTokens()).toBe(16384);
  });

  it('reasoning_effort "medium" → default 16384', async () => {
    await adapter.invoke(tierConfig({ reasoning_effort: 'medium' }), 'prompt');
    expect(lastMaxTokens()).toBe(16384);
  });

  it('reasoning_effort "high" → default 32768', async () => {
    await adapter.invoke(tierConfig({ reasoning_effort: 'high' }), 'prompt');
    expect(lastMaxTokens()).toBe(32768);
  });

  it('reasoning_effort "xhigh" → default 32768', async () => {
    await adapter.invoke(tierConfig({ reasoning_effort: 'xhigh' }), 'prompt');
    expect(lastMaxTokens()).toBe(32768);
  });

  it('explicit max_tokens always overrides the tiered default', async () => {
    await adapter.invoke(tierConfig({ reasoning_effort: 'high', max_tokens: 2048 }), 'prompt');
    expect(lastMaxTokens()).toBe(2048);
  });
});

// --------------------------------------------------------------------------
// Fuzzy model resolution — prefix-aware, boundary-respecting. A query must not
// grab a *variant* when a more precise base id exists (e.g. gpt-5 ≠ gpt-5-mini),
// and a boundary-less substring (gpt-4 vs gpt-4o) must not match at all.
// Exercised through the pi-ai registry path (no api_base_url), so resolveModel runs.
// --------------------------------------------------------------------------

describe('ApiAdapter.invoke — fuzzy model resolution (boundary-aware)', () => {
  let credManager: CredentialManager;
  let adapter: ApiAdapter;

  function registryConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
    return makeConfig({
      name: 'openai:gpt-5',
      provider: 'openai',
      model: 'gpt-5',
      api_base_url: undefined,
      api_key_env: undefined,
      ...overrides,
    });
  }

  /** Model returned by which completeSimple was invoked — reveals what resolveModel picked. */
  function resolvedModelId(): string {
    const callArgs = vi.mocked(completeSimple).mock.calls[0];
    const model = callArgs![0] as { id: string };
    return model.id;
  }

  function fakeModels(ids: string[]): Array<{ id: string; name: string; provider: string }> {
    return ids.map((id) => ({ id, name: id, provider: 'openai' }));
  }

  beforeEach(() => {
    vi.mocked(completeSimple).mockReset();
    vi.mocked(getModel).mockReset();
    vi.mocked(getModels).mockReset();
    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'ok' }],
      usage: { input: 1, output: 1 },
      errorMessage: undefined,
    } as never);
    // No exact registry hit — force the fuzzy path.
    vi.mocked(getModel).mockImplementation(() => { throw new Error('not found'); });
    credManager = makeFakeCredentialManager({
      getPiaiProvider: vi.fn().mockReturnValue('openai'),
      getApiKey: vi.fn().mockResolvedValue('sk-test'),
      getDirectSource: vi.fn().mockReturnValue('env'),
      getOAuthCredentials: vi.fn().mockReturnValue(undefined),
    });
    adapter = new ApiAdapter(credManager);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gpt-5 prefers the base gpt-5 over gpt-5-mini variant (shortest boundary match)', async () => {
    vi.mocked(getModels).mockReturnValue(fakeModels(['gpt-5-mini', 'gpt-5', 'gpt-5-nano']) as never);

    await adapter.invoke(registryConfig(), 'prompt');

    expect(resolvedModelId()).toBe('gpt-5');
  });

  it('gpt-5 still matches gpt-5-mini when it is the only boundary candidate', async () => {
    vi.mocked(getModels).mockReturnValue(fakeModels(['gpt-5-mini']) as never);

    await adapter.invoke(registryConfig(), 'prompt');

    expect(resolvedModelId()).toBe('gpt-5-mini');
  });

  it('gpt-4 does NOT match gpt-4o (no separator boundary) → throws not found', async () => {
    vi.mocked(getModels).mockReturnValue(fakeModels(['gpt-4o', 'gpt-4o-mini']) as never);

    await expect(
      adapter.invoke(registryConfig({ name: 'openai:gpt-4', model: 'gpt-4' }), 'prompt'),
    ).rejects.toThrow(InvocationError);
  });

  it('reverse prefix: query gpt-5-mini matches a shorter registered base gpt-5', async () => {
    vi.mocked(getModels).mockReturnValue(fakeModels(['gpt-5']) as never);

    await adapter.invoke(registryConfig({ name: 'openai:gpt-5-mini', model: 'gpt-5-mini' }), 'prompt');

    expect(resolvedModelId()).toBe('gpt-5');
  });
});

// --------------------------------------------------------------------------
// Usage null-safety — a provider that omits `usage` on a successful response must
// not turn the call into a failure. token_usage falls back to 0 instead of throwing.
// --------------------------------------------------------------------------

describe('ApiAdapter.invoke — missing usage is tolerated', () => {
  let credManager: CredentialManager;
  let adapter: ApiAdapter;

  function usageConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
    return makeConfig({
      api_base_url: 'https://api.example.com/v1',
      api_key_env: 'CUSTOM_API_KEY',
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.mocked(completeSimple).mockReset();
    vi.mocked(streamSimple).mockReset();
    credManager = makeFakeCredentialManager();
    adapter = new ApiAdapter(credManager);
    process.env['CUSTOM_API_KEY'] = 'sk-test';
  });

  afterEach(() => {
    delete process.env['CUSTOM_API_KEY'];
    vi.restoreAllMocks();
  });

  it('complete: usage undefined → success with token_usage 0/0, not a failure', async () => {
    vi.mocked(completeSimple).mockResolvedValue({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'answer' }],
      usage: undefined,
      errorMessage: undefined,
    } as never);

    const result = await adapter.invoke(usageConfig(), 'prompt');

    expect(result.response).toBe('answer');
    expect(result.token_usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(vi.mocked(recordSuccess)).toHaveBeenCalled();
  });

  it('streaming: usage undefined → success with token_usage 0/0', async () => {
    const stream = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'text_delta', delta: 'streamed' };
      },
      result: (): Promise<unknown> => Promise.resolve({
        stopReason: 'stop',
        content: [{ type: 'text', text: 'streamed' }],
        usage: undefined,
        errorMessage: undefined,
      }),
    };
    vi.mocked(streamSimple).mockReturnValue(stream as never);

    const chunks: string[] = [];
    const result = await adapter.invoke(usageConfig({ streaming: true }), 'prompt', (c) => chunks.push(c));

    expect(result.response).toBe('streamed');
    expect(result.token_usage).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});
