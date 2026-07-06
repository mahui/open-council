/**
 * Skeleton tests for the standard-API ApiAdapter (W2a). Proves the four reliability paths
 * — streaming, truncation, error classification/retry, timeout — against an injected fake
 * ProtocolClient, plus status-driven classification against genuine SDK error objects.
 *
 * These are intentionally minimal placeholders; the full SDK-mock suite is rebuilt in W5.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the health module so no real SQLite / throttle I/O happens in unit tests.
vi.mock('../../src/providers/health.js', () => ({
  throttle: vi.fn().mockResolvedValue(undefined),
  recordSuccess: vi.fn(),
  recordFailure: vi.fn(),
  getProviderStatus: vi.fn(() => 'healthy'),
}));

import { ApiAdapter } from '../../src/providers/api-adapter.js';
import type { ClientFactory } from '../../src/providers/api-adapter.js';
import { CredentialManager } from '../../src/providers/credentials/discovery.js';
import { classifyError, isRateLimit } from '../../src/providers/error-classifier.js';
import { InvocationError, InvocationTimeoutError } from '../../src/types/errors.js';
import type { ModelConfig } from '../../src/types/config.js';
import type { GenRequest, NormalizedEvent, NormalizedResult, ProtocolClient } from '../../src/providers/protocol/index.js';
import { recordFailure, recordSuccess, getProviderStatus } from '../../src/providers/health.js';
import { CredentialNotFoundError } from '../../src/types/errors.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

function makeConfig(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'test-model',
    protocol: 'openai',
    model: 'gpt-test',
    provider: `prov-${Math.random().toString(36).slice(2)}`, // unique circuit-breaker key per test
    timeout_seconds: 30,
    capabilities: ['general'],
    priority: 100,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: true,
    api_key_env: 'TEST_API_KEY',
    ...overrides,
  };
}

/** Build an adapter whose ProtocolClient is a supplied fake; instant sleep, no real retry delay. */
function adapterWith(client: Partial<ProtocolClient>): ApiAdapter {
  const factory: ClientFactory = () => ({
    stream: client.stream ?? (async () => ({ text: '', inputTokens: 0, outputTokens: 0, truncated: false })),
    complete: client.complete ?? (async () => ({ text: '', inputTokens: 0, outputTokens: 0, truncated: false })),
  });
  // Real CredentialManager: no I/O in its constructor; getApiKey reads TEST_API_KEY from env.
  return new ApiAdapter(new CredentialManager(), { clientFactory: factory, sleep: async () => {}, retryBaseMs: 0 });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env['TEST_API_KEY'] = 'sk-test-key';
});

describe('ApiAdapter — streaming path', () => {
  it('emits each chunk and returns the assembled response with usage', async () => {
    const client: Partial<ProtocolClient> = {
      async stream(_req: GenRequest, onEvent: (e: NormalizedEvent) => void): Promise<NormalizedResult> {
        onEvent({ textDelta: 'Hello' });
        onEvent({ textDelta: ', world' });
        return { text: 'Hello, world', inputTokens: 11, outputTokens: 3, truncated: false };
      },
    };
    const chunks: string[] = [];
    const result = await adapterWith(client).invoke(makeConfig(), 'hi', (c) => chunks.push(c));

    expect(chunks).toEqual(['Hello', ', world']);
    expect(result.response).toBe('Hello, world');
    expect(result.invocation_mode).toBe('api');
    expect(result.token_usage).toEqual({ input_tokens: 11, output_tokens: 3 });
    expect(result.truncated).toBe(false);
    expect(result.timed_out).toBe(false);
  });
});

describe('ApiAdapter — truncation path', () => {
  it('propagates truncated=true when the model hits its ceiling', async () => {
    const client: Partial<ProtocolClient> = {
      async complete(): Promise<NormalizedResult> {
        return { text: 'partial', inputTokens: 5, outputTokens: 8, truncated: true };
      },
    };
    const result = await adapterWith(client).invoke(makeConfig(), 'hi');
    expect(result.response).toBe('partial');
    expect(result.truncated).toBe(true);
  });
});

describe('ApiAdapter — classification / retry path', () => {
  it('retries a retryable (5xx) failure, then surfaces InvocationError', async () => {
    let calls = 0;
    const err = Object.assign(new Error('service unavailable'), { status: 503 });
    const client: Partial<ProtocolClient> = {
      async complete(): Promise<NormalizedResult> {
        calls++;
        throw err;
      },
    };
    await expect(adapterWith(client).invoke(makeConfig(), 'hi')).rejects.toBeInstanceOf(InvocationError);
    expect(calls).toBe(3); // initial + 2 retries (DEFAULT_MAX_RETRIES)
    expect(recordFailure).toHaveBeenCalledWith(expect.any(String), 'retryable', false);
  });

  it('does not retry a permanent (401) failure', async () => {
    let calls = 0;
    const err = Object.assign(new Error('unauthorized'), { status: 401 });
    const client: Partial<ProtocolClient> = {
      async complete(): Promise<NormalizedResult> {
        calls++;
        throw err;
      },
    };
    await expect(adapterWith(client).invoke(makeConfig(), 'hi')).rejects.toBeInstanceOf(InvocationError);
    expect(calls).toBe(1);
    expect(recordFailure).toHaveBeenCalledWith(expect.any(String), 'permanent', false);
  });
});

describe('ApiAdapter — timeout path', () => {
  it('reclassifies an SDK abort into InvocationTimeoutError once the idle guard fires', async () => {
    const client: Partial<ProtocolClient> = {
      // Hang until the adapter's guard aborts the signal, then throw an abort-like error.
      complete(req: GenRequest): Promise<NormalizedResult> {
        return new Promise((_resolve, reject) => {
          req.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('Request was aborted'), { name: 'APIUserAbortError' }));
          });
        });
      },
    };
    // 50ms idle timeout (fractional seconds — tests bypass the zod min).
    const result = adapterWith(client).invoke(makeConfig({ timeout_seconds: 0.05 }), 'hi');
    await expect(result).rejects.toBeInstanceOf(InvocationTimeoutError);
  });
});

describe('error-classifier — genuine SDK errors (R2)', () => {
  it('classifies a real Anthropic 429 (RateLimitError) as retryable and rate-limited', () => {
    // A Headers arg makes generate() produce the status-bearing subclass (else it degrades
    // to a statusless APIConnectionError).
    const err = Anthropic.APIError.generate(429, { error: { message: 'rate limited' } }, 'rate limited', new Headers());
    expect(err).toBeInstanceOf(Anthropic.RateLimitError);
    expect(classifyError(err)).toBe('retryable');
    expect(isRateLimit(err)).toBe(true);
  });

  it('classifies a real OpenAI 401 (AuthenticationError) as permanent', () => {
    const err = OpenAI.APIError.generate(401, { error: { message: 'bad key' } }, 'bad key', new Headers());
    expect(classifyError(err)).toBe('permanent');
    expect(isRateLimit(err)).toBe(false);
  });

  it('classifies a statusless APIConnectionError as retryable', () => {
    const err = new OpenAI.APIConnectionError({ message: 'connection failed' });
    expect(classifyError(err)).toBe('retryable');
  });
});

/**
 * Real SDKs honour AbortSignal natively: once the guard aborts, the underlying
 * request promise rejects (Anthropic/OpenAI throw an APIUserAbortError-shaped
 * error). A fake client that ignores the signal and just hangs forever would
 * make `invokeComplete`/`invokeStreaming` (which plain `await` the client, with
 * no independent race) hang the test too — so every fake client below must
 * react to `signal`'s abort event, exactly like the real SDKs do.
 */
function hangUntilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('Request was aborted'), { name: 'APIUserAbortError' }));
    });
  });
}

// --------------------------------------------------------------------------
// Timeout guard — additional boundary cases beyond the single-shot abort above:
// signal propagation, idle-reset-on-chunk, and the 120s default.
// --------------------------------------------------------------------------
describe('ApiAdapter — timeout guard (boundary cases)', () => {
  it('passes an AbortSignal to the client and aborts it once the deadline is crossed', async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    const client: Partial<ProtocolClient> = {
      complete(req: GenRequest): Promise<NormalizedResult> {
        capturedSignal = req.signal;
        return hangUntilAborted(req.signal);
      },
    };
    const captured = adapterWith(client)
      .invoke(makeConfig({ timeout_seconds: 15 }), 'prompt')
      .then(() => undefined, (e: unknown) => e);

    await vi.advanceTimersByTimeAsync(16_000);
    await captured;

    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(true);
    vi.useRealTimers();
  });

  it('streaming idle timer resets on each chunk; only trips once the stream actually stalls', async () => {
    vi.useFakeTimers();
    const client: Partial<ProtocolClient> = {
      async stream(req: GenRequest, onEvent: (e: NormalizedEvent) => void): Promise<NormalizedResult> {
        onEvent({ textDelta: 'a' });
        onEvent({ textDelta: 'b' });
        return hangUntilAborted(req.signal); // stall after both chunks are flushed
      },
    };
    const chunks: string[] = [];
    const captured = adapterWith(client)
      .invoke(makeConfig({ timeout_seconds: 10 }), 'prompt', (c) => chunks.push(c))
      .then(() => { throw new Error('should not resolve'); }, (e: unknown) => e);

    await vi.advanceTimersByTimeAsync(11_000);
    const err = await captured;

    expect(chunks).toEqual(['a', 'b']);
    expect(err).toBeInstanceOf(InvocationTimeoutError);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('defaults to 120s when timeout_seconds is omitted from the config', async () => {
    vi.useFakeTimers();
    const client: Partial<ProtocolClient> = {
      complete: (req: GenRequest) => hangUntilAborted(req.signal),
    };
    const base = makeConfig();
    const config = { ...base } as Partial<ModelConfig> & { timeout_seconds?: number };
    delete config.timeout_seconds;

    const captured = adapterWith(client)
      .invoke(config as ModelConfig, 'prompt')
      .then(() => undefined, (e: unknown) => e);

    // At 119s still pending — the default is not lower than 120s.
    await vi.advanceTimersByTimeAsync(119_000);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(2_000);
    const err = await captured;
    expect(err).toBeInstanceOf(InvocationTimeoutError);
    expect((err as Error).message).toContain('120s');
    vi.useRealTimers();
  });
});

// --------------------------------------------------------------------------
// Retry rhythm — exact backoff timing and the eventual-exhaustion / rate-limit
// bookkeeping paths that the minimal skeleton test didn't cover.
// --------------------------------------------------------------------------
describe('ApiAdapter — retry rhythm and exhaustion', () => {
  it('two retryable failures then success: backoff ~1s then ~4s (exponential, base 1000 factor 4)', async () => {
    const delays: number[] = [];
    let calls = 0;
    const err = Object.assign(new Error('unavailable'), { status: 503 });
    const client: Partial<ProtocolClient> = {
      async complete(): Promise<NormalizedResult> {
        calls++;
        if (calls <= 2) throw err;
        return { text: 'ok', inputTokens: 1, outputTokens: 1, truncated: false };
      },
    };
    const factory: ClientFactory = () => ({
      stream: client.stream ?? (async () => ({ text: '', inputTokens: 0, outputTokens: 0, truncated: false })),
      complete: client.complete ?? (async () => ({ text: '', inputTokens: 0, outputTokens: 0, truncated: false })),
    });
    const adapter = new ApiAdapter(new CredentialManager(), {
      clientFactory: factory,
      sleep: async (ms: number) => { delays.push(ms); },
    });

    const result = await adapter.invoke(makeConfig(), 'hi');

    expect(result.response).toBe('ok');
    expect(calls).toBe(3);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(1000);
    expect(delays[0]).toBeLessThan(1250);
    expect(delays[1]).toBeGreaterThanOrEqual(4000);
    expect(delays[1]).toBeLessThan(5000);
    expect(recordFailure).not.toHaveBeenCalled();
    expect(recordSuccess).toHaveBeenCalledTimes(1);
  });

  it('persistent 503 → retries exhausted (initial + 2 retries = 3 calls), recorded as retryable failure', async () => {
    const err = Object.assign(new Error('unavailable'), { status: 503 });
    const client: Partial<ProtocolClient> = {
      async complete(): Promise<NormalizedResult> { throw err; },
    };
    await expect(adapterWith(client).invoke(makeConfig(), 'hi')).rejects.toBeInstanceOf(InvocationError);
    expect(recordFailure).toHaveBeenCalledWith(expect.any(String), 'retryable', false);
  });

  it('429 rate limit exhausted → recorded with rateLimited=true', async () => {
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    const client: Partial<ProtocolClient> = {
      async complete(): Promise<NormalizedResult> { throw err; },
    };
    await expect(adapterWith(client).invoke(makeConfig(), 'hi')).rejects.toBeInstanceOf(InvocationError);
    expect(recordFailure).toHaveBeenCalledWith(expect.any(String), 'retryable', true);
  });

  it('a mid-stream failure (chunks already emitted) is never retried, even if classified retryable', async () => {
    let calls = 0;
    const err = Object.assign(new Error('unavailable'), { status: 503 });
    const client: Partial<ProtocolClient> = {
      async stream(_req: GenRequest, onEvent: (e: NormalizedEvent) => void): Promise<NormalizedResult> {
        calls++;
        onEvent({ textDelta: 'partial' });
        throw err;
      },
    };
    await expect(adapterWith(client).invoke(makeConfig(), 'hi', () => {})).rejects.toBeInstanceOf(InvocationError);
    // No retry attempted — a retry after an emitted chunk would double-emit to the caller.
    expect(calls).toBe(1);
  });
});

// --------------------------------------------------------------------------
// Circuit breaker bookkeeping — the adapter must fail fast (no client call at
// all) once the breaker for a provider is open, and must key the breaker off
// the explicit `provider` label (falling back to `protocol`).
// --------------------------------------------------------------------------
describe('ApiAdapter — circuit breaker bookkeeping', () => {
  it('an open circuit fails fast without ever invoking the client', async () => {
    // mockReturnValueOnce (not a persistent override) — the module-level mock's
    // default 'healthy' implementation must survive for every other test in this file.
    vi.mocked(getProviderStatus).mockReturnValueOnce('open');
    let called = false;
    const client: Partial<ProtocolClient> = {
      complete: async () => { called = true; return { text: '', inputTokens: 0, outputTokens: 0, truncated: false }; },
    };
    const err = await adapterWith(client).invoke(makeConfig(), 'hi').then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(InvocationError);
    expect((err as Error).message).toMatch(/circuit open/i);
    expect(called).toBe(false);
  });

  it('the circuit-breaker key is the explicit provider label, not the protocol', async () => {
    const client: Partial<ProtocolClient> = {
      complete: async () => { throw Object.assign(new Error('bad'), { status: 401 }); },
    };
    await expect(
      adapterWith(client).invoke(makeConfig({ provider: 'my-custom-label', protocol: 'openai' }), 'hi'),
    ).rejects.toBeInstanceOf(InvocationError);
    expect(recordFailure).toHaveBeenCalledWith('my-custom-label', 'permanent', false);
  });

  it('falls back to the protocol as the circuit-breaker key when no provider label is set', async () => {
    const client: Partial<ProtocolClient> = {
      complete: async () => { throw Object.assign(new Error('bad'), { status: 401 }); },
    };
    const config = makeConfig({ protocol: 'openai' });
    delete (config as Partial<ModelConfig>).provider;
    await expect(adapterWith(client).invoke(config, 'hi')).rejects.toBeInstanceOf(InvocationError);
    expect(recordFailure).toHaveBeenCalledWith('openai', 'permanent', false);
  });
});

// --------------------------------------------------------------------------
// Credential resolution — an official endpoint (no base_url) with no resolvable
// key is a hard failure; a custom endpoint tolerates an empty key (localhost /
// no-auth gateways).
// --------------------------------------------------------------------------
describe('ApiAdapter — credential resolution', () => {
  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TEST_API_KEY'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('an official endpoint with no key anywhere throws InvocationError (CredentialNotFoundError wrapped)', async () => {
    const client: Partial<ProtocolClient> = { complete: async () => ({ text: 'x', inputTokens: 0, outputTokens: 0, truncated: false }) };
    const config = makeConfig();
    delete (config as Partial<ModelConfig>).api_key_env;

    const err = await adapterWith(client).invoke(config, 'hi').then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(InvocationError);
    expect((err as Error).message).toMatch(/no credentials found/i);
  });

  it('a custom endpoint with no key anywhere is tolerated: an empty string is passed to the client factory', async () => {
    let receivedApiKey: string | undefined;
    const factory: ClientFactory = (_config, apiKey) => {
      receivedApiKey = apiKey;
      return { complete: async () => ({ text: 'ok', inputTokens: 0, outputTokens: 0, truncated: false }) };
    };
    const adapter = new ApiAdapter(new CredentialManager(), { clientFactory: factory, sleep: async () => {} });
    const config = makeConfig({ base_url: 'http://localhost:11434/v1' });
    delete (config as Partial<ModelConfig>).api_key_env;

    const result = await adapter.invoke(config, 'hi');
    expect(result.response).toBe('ok');
    expect(receivedApiKey).toBe('');
  });

  it('resolveApiKey surfaces the CredentialNotFoundError message exactly (sanity on the error type itself)', () => {
    const err = new CredentialNotFoundError('anthropic');
    expect(err.message).toBe('No credentials found for anthropic');
  });
});

// --------------------------------------------------------------------------
// healthCheck — local, network-free judgement of whether a model is runnable.
// --------------------------------------------------------------------------
describe('ApiAdapter.healthCheck', () => {
  const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TEST_API_KEY'] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('a resolvable API key → healthy', async () => {
    process.env['TEST_API_KEY'] = 'sk-test';
    const adapter = new ApiAdapter(new CredentialManager());
    const result = await adapter.healthCheck(makeConfig());
    expect(result.level).toBe('healthy');
    expect(result.message).toMatch(/api key available/i);
  });

  it('official endpoint (no base_url), no key anywhere → unavailable, names the expected env var', async () => {
    const adapter = new ApiAdapter(new CredentialManager());
    const config = makeConfig({ protocol: 'anthropic' });
    delete (config as Partial<ModelConfig>).api_key_env;
    const result = await adapter.healthCheck(config);
    expect(result.level).toBe('unavailable');
    expect(result.message).toContain('ANTHROPIC_API_KEY');
  });

  it('custom endpoint on localhost, no key → healthy (no-auth local server tolerated)', async () => {
    const adapter = new ApiAdapter(new CredentialManager());
    const config = makeConfig({ base_url: 'http://localhost:11434/v1' });
    delete (config as Partial<ModelConfig>).api_key_env;
    const result = await adapter.healthCheck(config);
    expect(result.level).toBe('healthy');
    expect(result.message).toMatch(/localhost/i);
  });

  it('custom endpoint on 127.0.0.1, no key → healthy (loopback tolerated)', async () => {
    const adapter = new ApiAdapter(new CredentialManager());
    const config = makeConfig({ base_url: 'http://127.0.0.1:8080/v1' });
    delete (config as Partial<ModelConfig>).api_key_env;
    const result = await adapter.healthCheck(config);
    expect(result.level).toBe('healthy');
  });

  it('a remote custom endpoint with no key → degraded (not a hard failure — some gateways need no auth)', async () => {
    const adapter = new ApiAdapter(new CredentialManager());
    const config = makeConfig({ base_url: 'https://api.example.com/v1' });
    delete (config as Partial<ModelConfig>).api_key_env;
    const result = await adapter.healthCheck(config);
    expect(result.level).toBe('degraded');
    expect(result.message).toContain('custom endpoint');
  });
});
