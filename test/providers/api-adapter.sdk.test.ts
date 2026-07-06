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
import { recordFailure } from '../../src/providers/health.js';
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
