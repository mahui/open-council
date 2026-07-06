import type { ModelConfig } from '../types/config.js';
import type { InvocationAdapter, InvocationResult, HealthStatus, OnChunk } from '../types/provider.js';
import { InvocationError, InvocationTimeoutError, CredentialNotFoundError } from '../types/errors.js';
import { CredentialManager } from './credentials/discovery.js';
import { throttle, recordSuccess, recordFailure, getProviderStatus } from './health.js';
import { classifyError, isRateLimit } from './error-classifier.js';
import { makeProtocolClient } from './protocol/index.js';
import type { GenRequest, ProtocolClient } from './protocol/index.js';

const DEBUG = !!process.env['COUNCIL_DEBUG'];

/**
 * Fallback timeout when config.timeout_seconds is absent. Kept high because reasoning
 * models can legitimately take minutes; a too-low default would kill valid slow responses.
 */
const DEFAULT_TIMEOUT_SECONDS = 120;

/**
 * Retry policy for transient (retryable) API failures. Two retries with exponential backoff
 * (base 1s, factor 4 → ~1s then ~4s, plus jitter) balances riding out a brief 429/503 blip
 * against not stalling a debate for too long before failing the model. Timeout and permanent
 * failures are never retried. These retries are the *only* retries in the stack — both SDK
 * clients are constructed with maxRetries:0 (design R6).
 */
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 1000;
const RETRY_BACKOFF_FACTOR = 4;
const RETRY_JITTER_FRACTION = 0.25;

/**
 * Default output-token budget, tiered by reasoning effort. Reasoning models spend a large,
 * invisible share of the budget on thinking tokens before emitting any answer, so a flat 8192
 * would clip their visible output. Scale the ceiling with effort so higher-effort requests get
 * room for both thinking and a complete answer. Tunable — adjust here, not at call sites.
 * - no reasoning              → 8192
 * - minimal / low / medium    → 16384
 * - high and above            → 32768
 */
const MAX_TOKENS_NO_REASONING = 8192;
const MAX_TOKENS_LOW_REASONING = 16384;
const MAX_TOKENS_HIGH_REASONING = 32768;

/**
 * Resolve the default max_tokens for a request from its reasoning effort. An explicit
 * `config.max_tokens` always wins over this (applied at the call site).
 */
function defaultMaxTokens(reasoning: ModelConfig['reasoning_effort']): number {
  switch (reasoning) {
    case undefined:
      return MAX_TOKENS_NO_REASONING;
    case 'minimal':
    case 'low':
    case 'medium':
      return MAX_TOKENS_LOW_REASONING;
    case 'high':
    case 'xhigh':
      return MAX_TOKENS_HIGH_REASONING;
  }
}

/** Factory for the per-call ProtocolClient — overridable in tests with a fake client. */
export type ClientFactory = (config: ModelConfig, apiKey: string, timeoutMs: number) => ProtocolClient;

/**
 * Injectable knobs — production uses the defaults; tests inject a synchronous/fake `sleep`
 * (or override the retry counts/timing) so backoff can be asserted without real waiting, and
 * a `clientFactory` returning a fake ProtocolClient so the SDK is never really contacted.
 */
export interface ApiAdapterOptions {
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  retryBaseMs?: number;
  clientFactory?: ClientFactory;
}

function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[api-adapter] ${msg}\n`);
}

/** Circuit-breaker / throttle bucket key: explicit label, else the protocol. */
function providerKey(config: ModelConfig): string {
  return config.provider ?? config.protocol;
}

/**
 * An idle-timeout guard built on a real AbortController. The official SDKs honour AbortSignal
 * natively (unlike the old pi-ai path, which needed a racing "expired" promise as a belt-and-
 * suspenders — now removed, design R1). On timeout we abort the SDK request; the SDK throws
 * `APIUserAbortError`, which the caller reclassifies as InvocationTimeoutError via `timedOut`.
 *
 * - `signal` is passed to the SDK request options.
 * - `reset()` restarts the countdown — call it on each streamed chunk to get an *idle* timeout
 *   (only a genuinely stalled stream trips it; a slow-but-progressing one does not).
 * - `dispose()` clears the timer; always call it in a finally block so no timer leaks.
 * - `timedOut` lets the caller recognise an SDK abort that we caused as a timeout.
 */
interface TimeoutGuard {
  readonly signal: AbortSignal;
  readonly timedOut: boolean;
  reset(): void;
  dispose(): void;
}

function createTimeoutGuard(seconds: number): TimeoutGuard {
  const controller = new AbortController();
  const ms = seconds * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const arm = (): void => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  arm();

  return {
    signal: controller.signal,
    get timedOut(): boolean {
      return timedOut;
    },
    reset(): void {
      if (timedOut) return;
      if (timer) clearTimeout(timer);
      arm();
    },
    dispose(): void {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/**
 * Standard-API adapter: drives the two official SDKs through a protocol-neutral ProtocolClient.
 * The reliability skeleton — idle timeout, exponential-backoff retry, circuit-breaker
 * bookkeeping, truncation flagging, usage fallback — lives here; SDK specifics live in the
 * two ProtocolClient implementations. Implements the unchanged InvocationAdapter contract.
 */
export class ApiAdapter implements InvocationAdapter {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly clientFactory: ClientFactory;

  constructor(private readonly credentialManager: CredentialManager, options: ApiAdapterOptions = {}) {
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.clientFactory = options.clientFactory ?? makeProtocolClient;
  }

  async invoke(config: ModelConfig, prompt: string, onChunk?: OnChunk): Promise<InvocationResult> {
    const provider = providerKey(config);

    // Circuit breaker check — fail fast (there is no CLI fallback any more).
    if (getProviderStatus(provider) === 'open') {
      throw new InvocationError(
        config.name, 'api',
        `Provider ${provider} circuit open (too many failures); skipping model`,
      );
    }

    debug(`invoke: provider=${provider}, protocol=${config.protocol}, model=${config.model}, streaming=${!!onChunk}`);
    return this.executeWithHealth(provider, config, prompt, onChunk);
  }

  /**
   * Shared invocation tail: throttle → resolve key + build client → invoke (with retry) →
   * record health. On failure the error is classified once (after retries are exhausted) and
   * reported to the circuit breaker with its category, so a single transient blip absorbed by a
   * retry never accumulates as a consecutive failure. Recognisable error types are re-thrown
   * intact so the orchestrator can distinguish timeout / invocation failures.
   */
  private async executeWithHealth(
    provider: string,
    config: ModelConfig,
    prompt: string,
    onChunk: OnChunk | undefined,
  ): Promise<InvocationResult> {
    await throttle(provider);
    const start = Date.now();
    try {
      const apiKey = this.resolveApiKey(config);
      const timeoutSeconds = config.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
      const client = this.clientFactory(config, apiKey, timeoutSeconds * 1000);

      // Track streamed emission so a mid-stream failure is not retried (would double-emit chunks).
      let emitted = 0;
      const wrappedChunk: OnChunk | undefined = onChunk
        ? (c): void => { emitted++; onChunk(c); }
        : undefined;

      const result = await this.withRetry(
        () => wrappedChunk
          ? this.invokeStreaming(client, prompt, config, wrappedChunk)
          : this.invokeComplete(client, prompt, config),
        () => emitted === 0,
      );
      debug(`result: responseLen=${result.response.length}, tokens=${JSON.stringify(result.token_usage)}`);

      recordSuccess(provider);
      return { ...result, elapsed_ms: Date.now() - start };
    } catch (err) {
      const cls = classifyError(err);
      debug(`error (class=${cls}): ${err instanceof Error ? err.message : String(err)}`);
      recordFailure(provider, cls, isRateLimit(err));
      // Preserve recognisable error types (timeout / invocation) so callers can distinguish them.
      if (err instanceof InvocationTimeoutError || err instanceof InvocationError) throw err;
      throw new InvocationError(
        config.name, 'api',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Run `op`, retrying only `retryable` failures with exponential backoff + jitter, up to
   * `maxRetries` times. `timeout` (already burned the deadline) and `permanent` (auth/param)
   * failures throw immediately. `canRetry` lets the caller veto a retry that would be unsafe
   * (e.g. streaming that already emitted chunks). The final failure is re-thrown for the caller
   * to classify and report to the circuit breaker exactly once.
   */
  private async withRetry<T>(op: () => Promise<T>, canRetry: () => boolean): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        return await op();
      } catch (err) {
        const cls = classifyError(err);
        if (cls !== 'retryable' || attempt >= this.maxRetries || !canRetry()) {
          throw err;
        }
        const delay = this.backoffDelay(attempt);
        debug(`retryable failure (attempt ${attempt + 1}/${this.maxRetries}), backing off ${delay}ms: ${err instanceof Error ? err.message : String(err)}`);
        attempt++;
        await this.sleep(delay);
      }
    }
  }

  /** Exponential backoff with jitter: base·factor^attempt plus up to RETRY_JITTER_FRACTION extra. */
  private backoffDelay(attempt: number): number {
    const base = this.retryBaseMs * Math.pow(RETRY_BACKOFF_FACTOR, attempt);
    const jitter = Math.floor(Math.random() * base * RETRY_JITTER_FRACTION);
    return base + jitter;
  }

  /**
   * Local-only health check (no network): a model is healthy when the CredentialManager can
   * resolve a key for it. Custom endpoints tolerate no key — localhost is healthy (no-auth
   * servers like Ollama), other custom endpoints are degraded-but-usable (some gateways need
   * no auth); an official endpoint with no key is unavailable.
   */
  async healthCheck(config: ModelConfig): Promise<HealthStatus> {
    const now = new Date().toISOString();

    const key = this.credentialManager.getApiKey(config);
    if (key !== null && key.length > 0) {
      return { level: 'healthy', message: 'API key available', checked_at: now };
    }
    if (config.base_url && isLocalBaseUrl(config.base_url)) {
      return { level: 'healthy', message: 'localhost endpoint, no auth required', checked_at: now };
    }
    if (config.base_url) {
      return { level: 'degraded', message: 'custom endpoint, no API key configured', checked_at: now };
    }
    return { level: 'unavailable', message: `No API key (set ${defaultKeyEnv(config.protocol)})`, checked_at: now };
  }

  /**
   * Resolve the API key for a model via the CredentialManager (env → key file → protocol
   * default env → null). A custom endpoint with no key passes '' through (localhost / gateways
   * that need no auth); an official endpoint with no key is a hard CredentialNotFoundError.
   */
  private resolveApiKey(config: ModelConfig): string {
    const key = this.credentialManager.getApiKey(config);
    if (key !== null) return key;

    // No key resolved. Custom endpoints (incl. localhost) may need no auth.
    if (config.base_url) return '';

    // Official endpoint with no key anywhere → hard failure.
    throw new CredentialNotFoundError(config.provider ?? config.protocol);
  }

  private async invokeStreaming(
    client: ProtocolClient, prompt: string, config: ModelConfig, onChunk: OnChunk,
  ): Promise<Omit<InvocationResult, 'elapsed_ms'>> {
    const timeoutSeconds = config.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
    const guard = createTimeoutGuard(timeoutSeconds);
    try {
      const result = await client.stream(this.buildRequest(config, prompt, guard.signal), (e) => {
        guard.reset(); // activity observed — restart the idle countdown
        onChunk(e.textDelta);
      });
      return this.toResult(result);
    } catch (err) {
      // The SDK throws its own abort error when we abort; reclassify as a timeout.
      if (guard.timedOut && !(err instanceof InvocationTimeoutError)) {
        throw new InvocationTimeoutError(config.name, 'api', timeoutSeconds);
      }
      throw err;
    } finally {
      guard.dispose();
    }
  }

  private async invokeComplete(
    client: ProtocolClient, prompt: string, config: ModelConfig,
  ): Promise<Omit<InvocationResult, 'elapsed_ms'>> {
    const timeoutSeconds = config.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
    const guard = createTimeoutGuard(timeoutSeconds);
    try {
      const result = await client.complete(this.buildRequest(config, prompt, guard.signal));
      return this.toResult(result);
    } catch (err) {
      if (guard.timedOut && !(err instanceof InvocationTimeoutError)) {
        throw new InvocationTimeoutError(config.name, 'api', timeoutSeconds);
      }
      throw err;
    } finally {
      guard.dispose();
    }
  }

  private buildRequest(config: ModelConfig, prompt: string, signal: AbortSignal): GenRequest {
    return {
      model: config.model,
      prompt,
      maxTokens: config.max_tokens ?? defaultMaxTokens(config.reasoning_effort),
      temperature: config.temperature,
      reasoningEffort: config.reasoning_effort,
      signal,
    };
  }

  private toResult(result: {
    text: string; inputTokens: number; outputTokens: number; truncated: boolean;
  }): Omit<InvocationResult, 'elapsed_ms'> {
    return {
      response: result.text,
      invocation_mode: 'api',
      http_status: 200,
      // Some compatible endpoints omit usage entirely; the client already fell back to 0 rather
      // than turning a good call into a failure.
      token_usage: { input_tokens: result.inputTokens, output_tokens: result.outputTokens },
      timed_out: false,
      // The model hit its max_tokens/length ceiling: content is real but clipped. Flag it
      // (content still returned) so the orchestrator can surface it.
      truncated: result.truncated,
    };
  }
}

/** The conventional env var holding the API key for a protocol's official endpoint. */
function defaultKeyEnv(protocol: ModelConfig['protocol']): string {
  return protocol === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/** True if baseUrl points at a local interface — allows no-auth health checks for ollama / vLLM / docker-bound dev servers. */
function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}
