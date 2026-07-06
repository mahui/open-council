import { readFileSync, existsSync } from 'node:fs';
import {
  getModel,
  getModels,
  streamSimple,
  completeSimple,
} from '@mariozechner/pi-ai';
import type { Api, Model, KnownProvider } from '@mariozechner/pi-ai';
import { getOAuthProvider } from '@mariozechner/pi-ai/oauth';
import type { ModelConfig } from '../types/config.js';
import type { InvocationAdapter, InvocationResult, HealthStatus, OnChunk } from '../types/provider.js';
import { InvocationError, InvocationTimeoutError } from '../types/errors.js';
import type { CredentialManager } from './credentials/discovery.js';
import { throttle, recordSuccess, recordFailure, getProviderStatus } from './health.js';
import { classifyError, isRateLimit } from './error-classifier.js';
import { isPrefixAtBoundary } from '../shared/match.js';

/**
 * Every Google-family provider that may hold a callable credential or list a model.
 * A model discovered under any one of these (e.g. `google-vertex` via the discovery
 * OAUTH_ALSO_TRY table) must be resolvable against the shared Google OAuth credential
 * at call time — so all four keys map to this same candidate set. `resolveModel`
 * re-sorts by credential strength, so the list order here is not significant.
 */
const GOOGLE_FAMILY = ['google-antigravity', 'google-gemini-cli', 'google', 'google-vertex'];

/**
 * Map from provider names (legacy or pi-ai) to all related pi-ai providers.
 * Used to expand a single provider into all places a model might live.
 *
 * INVARIANT (asserted by test/providers/table-symmetry.test.ts): every provider that
 * the discovery-time OAUTH_ALSO_TRY table can attach to a discovered model must have a
 * key here, or that model would be undiscoverable-then-uncallable (the google-vertex bug).
 */
export const RELATED_PROVIDERS: Record<string, string[]> = {
  'anthropic': ['anthropic'],
  'openai': ['openai', 'openai-codex'],
  'openai-codex': ['openai-codex', 'openai'],
  'google': GOOGLE_FAMILY,
  'google-gemini-cli': GOOGLE_FAMILY,
  'google-antigravity': GOOGLE_FAMILY,
  'google-vertex': GOOGLE_FAMILY,
  'github-copilot': ['github-copilot'],
};

const DEBUG = !!process.env['COUNCIL_DEBUG'];

/**
 * Fallback timeout when config.timeout_seconds is absent. Kept high because reasoning
 * models can legitimately take minutes; a too-low default would kill valid slow responses.
 */
const DEFAULT_TIMEOUT_SECONDS = 120;

/**
 * Retry policy for transient (retryable) API failures. Two retries with exponential backoff
 * (base 1s, factor 4 → ~1s then ~4s, plus jitter) balances riding out a brief 429/503 blip
 * against not stalling a debate for too long before falling back to CLI. Timeout and permanent
 * failures are never retried.
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
 * - no reasoning         → 8192
 * - minimal / low / medium → 16384
 * - high and above (high, xhigh) → 32768
 */
const MAX_TOKENS_NO_REASONING = 8192;
const MAX_TOKENS_LOW_REASONING = 16384;
const MAX_TOKENS_HIGH_REASONING = 32768;

/**
 * Default contextWindow for custom OpenAI-compatible endpoints. Mainstream self-hosted / gateway
 * models are ≥128k; a low value would make pi-ai under-budget the request. 8192 was misleading.
 */
const CUSTOM_MODEL_CONTEXT_WINDOW = 131072;

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

/**
 * Injectable knobs — production uses the defaults; tests inject a synchronous/fake `sleep`
 * (or override the retry counts/timing) so backoff can be asserted without real waiting.
 */
export interface ApiAdapterOptions {
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  retryBaseMs?: number;
}

function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[api-adapter] ${msg}\n`);
}

/**
 * A timeout guard combining a real AbortController (so pi-ai cancels the underlying HTTP
 * request and frees sockets) with a rejecting promise (so our own invoke settles even if
 * the underlying call ignores the signal — belt-and-suspenders against a truly hung call).
 *
 * - `signal` is passed to pi-ai's stream/complete options.
 * - `expired` rejects with InvocationTimeoutError once the (idle) countdown elapses; race it
 *   against the actual work so the loser can never hang us.
 * - `reset()` restarts the countdown — call it on each streamed chunk to get an *idle* timeout
 *   (only a genuinely stalled stream trips it, a slow-but-progressing one does not).
 * - `dispose()` clears the timer; always call it in a finally block so no timer leaks.
 * - `timedOut` lets the caller reclassify a pi-ai-originated AbortError as a timeout.
 */
interface TimeoutGuard {
  readonly signal: AbortSignal;
  readonly expired: Promise<never>;
  readonly timedOut: boolean;
  reset(): void;
  dispose(): void;
}

function createTimeoutGuard(seconds: number, modelName: string): TimeoutGuard {
  const controller = new AbortController();
  const ms = seconds * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let rejectExpired: (err: Error) => void = () => {};

  const expired = new Promise<never>((_, reject) => {
    rejectExpired = reject;
  });
  // Prevent an "unhandled rejection" if the guard is disposed before the timer fires:
  // the promise is always raced (thus handled), but attach a no-op catch as a safety net.
  expired.catch(() => {});

  const arm = (): void => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectExpired(new InvocationTimeoutError(modelName, 'api', seconds));
    }, ms);
  };
  arm();

  return {
    signal: controller.signal,
    expired,
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

export class ApiAdapter implements InvocationAdapter {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;

  constructor(private credentialManager: CredentialManager, options: ApiAdapterOptions = {}) {
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  }

  async invoke(config: ModelConfig, prompt: string, onChunk?: OnChunk): Promise<InvocationResult> {
    const provider = config.provider!;

    // Circuit breaker check
    const status = getProviderStatus(provider);
    if (status === 'open') {
      throw new InvocationError(config.name, 'api', `Provider ${provider} circuit open (too many failures), falling back to CLI`);
    }

    // Custom OpenAI-compatible endpoint branch — bypass pi-ai model registry entirely.
    // Isolated from the OAuth/env path so existing call paths remain untouched.
    if (config.api_base_url) {
      debug(`invoke: provider=${provider}, model=${config.model}, streaming=${!!onChunk}, customEndpoint=true`);
      return this.executeWithHealth(provider, config, prompt, onChunk, async () => {
        const model = this.buildCustomModel(config);
        const apiKey = await this.resolveApiKey(config);
        debug(`custom model built: id=${model.id}, baseUrl=${model.baseUrl}, apiKeyLen=${apiKey.length}, customEndpoint=true`);
        return { model, apiKey };
      });
    }

    const piaiProvider = this.credentialManager.getPiaiProvider(provider);
    debug(`invoke: provider=${provider}, piaiProvider=${piaiProvider}, model=${config.model}, streaming=${!!onChunk}`);

    return this.executeWithHealth(provider, config, prompt, onChunk, async () => {
      const model = this.resolveModel(piaiProvider, config.model ?? config.name);
      debug(`resolved model: id=${model.id}, provider=${model.provider}, api=${model.api}, baseUrl=${model.baseUrl}`);

      // Get API key matching the resolved model's provider, not the config provider.
      // E.g. config says 'google' but model resolved to 'google-gemini-cli' — use OAuth key.
      const apiKey = await this.credentialManager.getApiKey(model.provider)
        .catch(() => this.credentialManager.getApiKey(provider));
      debug(`apiKey prefix: ${apiKey.substring(0, 12)}...`);
      return { model, apiKey };
    });
  }

  /**
   * Shared invocation tail: throttle → build model/key → invoke (with retry) → record health.
   * `build` resolves the model + apiKey lazily so both the custom-endpoint and pi-ai-registry
   * paths reuse identical retry, classification, and circuit-breaker bookkeeping.
   *
   * On failure the error is classified once (after retries are exhausted) and reported to the
   * circuit breaker with its category, so a single transient blip absorbed by a retry never
   * accumulates as a consecutive failure. Recognisable error types are re-thrown intact so the
   * AutoAdapter can distinguish timeout / invocation failures on its way to CLI fallback.
   */
  private async executeWithHealth(
    provider: string,
    config: ModelConfig,
    prompt: string,
    onChunk: OnChunk | undefined,
    build: () => Promise<{ model: Model<Api>; apiKey: string }>,
  ): Promise<InvocationResult> {
    await throttle(provider);
    const start = Date.now();
    try {
      const { model, apiKey } = await build();

      // Track streamed emission so a mid-stream failure is not retried (would double-emit chunks).
      let emitted = 0;
      const wrappedChunk: OnChunk | undefined = onChunk
        ? (c): void => { emitted++; onChunk(c); }
        : undefined;

      const result = await this.withRetry(
        () => wrappedChunk
          ? this.invokeStreaming(model, prompt, apiKey, config, wrappedChunk)
          : this.invokeComplete(model, prompt, apiKey, config),
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

  async healthCheck(config: ModelConfig): Promise<HealthStatus> {
    const now = new Date().toISOString();
    if (!config.provider) {
      return { level: 'unavailable', message: 'No provider configured', checked_at: now };
    }

    // Custom OpenAI-compatible endpoint — credential check is local only (no pi-ai registry lookup).
    if (config.api_base_url) {
      if (config.api_key_env) {
        const val = process.env[config.api_key_env];
        if (val && val.length > 0) {
          return { level: 'healthy', message: `env ${config.api_key_env} present`, checked_at: now };
        }
        return {
          level: 'unavailable',
          message: `Custom endpoint requires env var ${config.api_key_env} (not set)`,
          checked_at: now,
        };
      }
      if (config.api_credential_path) {
        if (existsSync(config.api_credential_path)) {
          return { level: 'healthy', message: `credential file present`, checked_at: now };
        }
        return {
          level: 'unavailable',
          message: `Custom endpoint credential file missing: ${config.api_credential_path}`,
          checked_at: now,
        };
      }
      // No api_key_env, no api_credential_path → only allow if baseUrl is localhost (no-auth scenario, e.g. ollama).
      if (isLocalBaseUrl(config.api_base_url)) {
        return { level: 'healthy', message: 'localhost endpoint, no auth required', checked_at: now };
      }
      return {
        level: 'unavailable',
        message: `Custom endpoint ${config.api_base_url} has no api_key_env or api_credential_path configured`,
        checked_at: now,
      };
    }

    try {
      const hasCredential = this.credentialManager.hasCredential(config.provider);
      if (!hasCredential) {
        return { level: 'unavailable', message: `No credentials for ${config.provider}`, checked_at: now };
      }
      return { level: 'healthy', message: 'Credentials available', checked_at: now };
    } catch {
      return { level: 'unavailable', message: 'Credential check failed', checked_at: now };
    }
  }

  /**
   * Build a Model object for a custom OpenAI-compatible endpoint without consulting pi-ai's registry.
   * Pure literal construction — no spread of an existing model — so the model has no inherited
   * cost/contextWindow assumptions. `compat` left undefined so pi-ai auto-detects from baseUrl.
   * WHY: lets users point at any OpenAI-compatible service (ollama, vLLM, LiteLLM, third-party gateways)
   * without us shipping a registry entry.
   */
  private buildCustomModel(config: ModelConfig): Model<'openai-completions'> {
    return {
      id: config.model!,
      name: config.model!,
      api: 'openai-completions' as const,
      provider: config.provider!,
      baseUrl: config.api_base_url!,
      reasoning: false,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      // Mainstream custom endpoints are ≥128k; a low window would make pi-ai under-budget requests.
      contextWindow: CUSTOM_MODEL_CONTEXT_WINDOW,
      // Keep the default aligned with the request-side tiering (reasoning-aware) rather than a
      // separate hardcoded 4096, so custom endpoints don't clip reasoning output.
      maxTokens: config.max_tokens ?? defaultMaxTokens(config.reasoning_effort),
    };
  }

  /**
   * Resolve API key for a custom endpoint. Priority: api_key_env → api_credential_path → CredentialManager fallback.
   * WHY empty string is allowed: ollama and similar local servers accept any value (or none) for the auth header,
   * so we transparently pass through an empty key rather than refusing the call.
   */
  private async resolveApiKey(config: ModelConfig): Promise<string> {
    if (config.api_key_env) {
      const val = process.env[config.api_key_env];
      if (val === undefined) {
        throw new InvocationError(
          config.name, 'api',
          `api_key_env '${config.api_key_env}' is not set in environment`,
        );
      }
      return val;
    }
    if (config.api_credential_path) {
      try {
        return readFileSync(config.api_credential_path, 'utf8').trim();
      } catch (err) {
        throw new InvocationError(
          config.name, 'api',
          `Failed to read api_credential_path '${config.api_credential_path}': ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Fallback to CredentialManager. May return empty string for no-auth localhost endpoints.
    try {
      return await this.credentialManager.getApiKey(config.provider!);
    } catch {
      return '';
    }
  }

  /**
   * Resolve a model from pi-ai's registry.
   * Builds an ordered list of providers to try — those with OAuth credentials first
   * (since they're more likely to work), then generic providers.
   */
  private resolveModel(piaiProvider: string, modelId: string): Model<Api> {
    const candidates = RELATED_PROVIDERS[piaiProvider] ?? [piaiProvider];
    // Sort: providers with direct OAuth credentials first, then env, then unknown.
    // Uses getDirectSource (no legacy mapping) so each candidate is scored independently.
    const sorted = [...candidates].sort((a, b) => {
      const scoreOf = (p: string) => {
        const src = this.credentialManager.getDirectSource(p);
        if (src === 'oauth') return 2;
        if (src === 'env') return 1;
        return 0;
      };
      return scoreOf(b) - scoreOf(a);
    });
    debug(`resolveModel: modelId=${modelId}, candidates=[${sorted.join(',')}]`);

    // 1. Exact match
    for (const p of sorted) {
      try {
        const model = getModel(p as KnownProvider, modelId as never);
        return this.applyOAuthModifications(p, model);
      } catch { /* not found in this provider */ }
    }

    // 2. Fuzzy match — prefix-aware and boundary-respecting. A plain substring test lets a
    //    query like `gpt-5` grab `gpt-5-mini`; here a candidate only matches when one id is a
    //    boundary-terminated prefix of the other (next char is '-'/'.'/a version-digit boundary).
    //    Among all matches we keep the *shortest* id — the most precise base model — with the
    //    provider preference order (already sorted by credential strength) breaking ties.
    let best: { provider: string; model: Model<Api> } | undefined;
    for (const p of sorted) {
      try {
        const models = getModels(p as KnownProvider);
        for (const m of models) {
          const matches =
            m.id === modelId ||
            isPrefixAtBoundary(m.id, modelId) ||
            isPrefixAtBoundary(modelId, m.id);
          if (!matches) continue;
          // Strict `<` so, on equal length, the earlier (more credentialed) provider wins.
          if (!best || m.id.length < best.model.id.length) {
            best = { provider: p, model: m as Model<Api> };
          }
        }
      } catch { /* provider not found */ }
    }
    if (best) {
      debug(`fuzzy matched ${modelId} → ${best.model.id} (provider=${best.provider})`);
      return this.applyOAuthModifications(best.provider, best.model);
    }

    throw new InvocationError(modelId, 'api', `Model '${modelId}' not found in providers [${sorted.join(', ')}]`);
  }

  /** Apply OAuth provider's modifyModels() if available (e.g. GitHub Copilot sets baseUrl). */
  private applyOAuthModifications(piaiProvider: string, model: Model<Api>): Model<Api> {
    const oauthCreds = this.credentialManager.getOAuthCredentials(piaiProvider);
    if (!oauthCreds) return model;

    const oauthProvider = getOAuthProvider(piaiProvider);
    if (!oauthProvider?.modifyModels) return model;

    const modified = oauthProvider.modifyModels([model], oauthCreds);
    return modified[0] ?? model;
  }

  private async invokeStreaming(
    model: Model<Api>, prompt: string, apiKey: string,
    config: ModelConfig, onChunk: OnChunk,
  ): Promise<Omit<InvocationResult, 'elapsed_ms'>> {
    const timeoutSeconds = config.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
    const guard = createTimeoutGuard(timeoutSeconds, config.name);
    const textParts: string[] = [];

    try {
      const eventStream = streamSimple(model, {
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
      }, {
        apiKey,
        signal: guard.signal,
        maxTokens: config.max_tokens ?? defaultMaxTokens(config.reasoning_effort),
        temperature: config.temperature,
        reasoning: config.reasoning_effort,
      });

      // Consume the whole stream, then fetch its final result. Wrapped so it can be raced
      // against the idle-timeout guard: an idle (stalled) stream trips `guard.expired`.
      const consume = async (): Promise<Awaited<ReturnType<typeof eventStream.result>>> => {
        let eventCount = 0;
        const eventTypes = new Set<string>();
        for await (const event of eventStream) {
          guard.reset(); // activity observed — restart the idle countdown
          eventCount++;
          eventTypes.add(event.type);
          if (event.type === 'text_delta') {
            onChunk(event.delta);
            textParts.push(event.delta);
          }
        }
        debug(`stream events: count=${eventCount}, types=[${[...eventTypes].join(',')}], textParts=${textParts.length}`);
        return eventStream.result();
      };

      const message = await Promise.race([consume(), guard.expired]);
      debug(`stream result: stopReason=${message.stopReason}, contentBlocks=${message.content.length}, types=[${message.content.map(c => c.type).join(',')}]`);
      if (message.errorMessage) debug(`stream errorMessage: ${message.errorMessage}`);

      // If pi-ai surfaced the abort itself (returned instead of threw), treat our timeout as timeout.
      if (message.stopReason === 'aborted' && guard.timedOut) {
        throw new InvocationTimeoutError(config.name, 'api', timeoutSeconds);
      }

      // pi-ai returns stopReason='error' on API failures — must propagate
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        throw new InvocationError(
          config.name, 'api',
          message.errorMessage ?? `API call failed (${message.stopReason})`,
        );
      }

      // Fallback: if streaming collected nothing, extract from final message
      let response = textParts.join('');
      if (!response) {
        response = extractText(message);
        debug(`stream fallback extractText: len=${response.length}`);
      }

      return {
        response,
        invocation_mode: 'api',
        http_status: 200,
        // Guard usage: some providers omit it entirely on a successful response. Missing usage
        // must not turn a good call into a failure, so fall back to 0 rather than reading undefined.
        token_usage: {
          input_tokens: message.usage?.input ?? 0,
          output_tokens: message.usage?.output ?? 0,
        },
        timed_out: false,
        // pi-ai StopReason `length` means the model hit the max_tokens ceiling: content is
        // real but clipped. Flag it (content still returned) so the orchestrator can surface it.
        truncated: message.stopReason === 'length',
      };
    } catch (err) {
      // pi-ai may throw its own AbortError when we abort; reclassify as a timeout.
      if (guard.timedOut && !(err instanceof InvocationTimeoutError)) {
        throw new InvocationTimeoutError(config.name, 'api', timeoutSeconds);
      }
      throw err;
    } finally {
      guard.dispose();
    }
  }

  private async invokeComplete(
    model: Model<Api>, prompt: string, apiKey: string,
    config: ModelConfig,
  ): Promise<Omit<InvocationResult, 'elapsed_ms'>> {
    const timeoutSeconds = config.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
    const guard = createTimeoutGuard(timeoutSeconds, config.name);

    try {
      debug(`complete: calling completeSimple...`);
      const message = await Promise.race([
        completeSimple(model, {
          messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        }, {
          apiKey,
          signal: guard.signal,
          maxTokens: config.max_tokens ?? defaultMaxTokens(config.reasoning_effort),
          temperature: config.temperature,
          reasoning: config.reasoning_effort,
        }),
        guard.expired,
      ]);
      debug(`complete result: stopReason=${message.stopReason}, contentBlocks=${message.content.length}, types=[${message.content.map(c => c.type).join(',')}]`);
      if (message.errorMessage) debug(`complete errorMessage: ${message.errorMessage}`);

      // If pi-ai surfaced the abort itself (returned instead of threw), treat our timeout as timeout.
      if (message.stopReason === 'aborted' && guard.timedOut) {
        throw new InvocationTimeoutError(config.name, 'api', timeoutSeconds);
      }

      // pi-ai returns stopReason='error' on API failures — must propagate
      if (message.stopReason === 'error' || message.stopReason === 'aborted') {
        throw new InvocationError(
          config.name, 'api',
          message.errorMessage ?? `API call failed (${message.stopReason})`,
        );
      }

      const response = extractText(message);
      debug(`complete extractText: len=${response.length}`);

      return {
        response,
        invocation_mode: 'api',
        http_status: 200,
        // Guard usage: some providers omit it entirely on a successful response. Missing usage
        // must not turn a good call into a failure, so fall back to 0 rather than reading undefined.
        token_usage: {
          input_tokens: message.usage?.input ?? 0,
          output_tokens: message.usage?.output ?? 0,
        },
        timed_out: false,
        // pi-ai StopReason `length` means the model hit the max_tokens ceiling: content is
        // real but clipped. Flag it (content still returned) so the orchestrator can surface it.
        truncated: message.stopReason === 'length',
      };
    } catch (err) {
      // pi-ai may throw its own AbortError when we abort; reclassify as a timeout.
      if (guard.timedOut && !(err instanceof InvocationTimeoutError)) {
        throw new InvocationTimeoutError(config.name, 'api', timeoutSeconds);
      }
      throw err;
    } finally {
      guard.dispose();
    }
  }
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

/** Extract text from an AssistantMessage. Falls back to thinking content if no text found. */
function extractText(message: { content: Array<{ type: string; text?: string; thinking?: string }> }): string {
  // Prefer text content
  const text = message.content
    .filter(c => c.type === 'text' && c.text)
    .map(c => c.text!)
    .join('');
  if (text) return text;

  // Fallback: use thinking content if no text blocks
  const thinking = message.content
    .filter(c => c.type === 'thinking' && c.thinking)
    .map(c => c.thinking!)
    .join('');
  return thinking;
}
