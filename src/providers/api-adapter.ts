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
import { InvocationError } from '../types/errors.js';
import type { CredentialManager } from './credentials/discovery.js';
import { throttle, recordSuccess, recordFailure, getProviderStatus } from './health.js';

/**
 * Map from provider names (legacy or pi-ai) to all related pi-ai providers.
 * Used to expand a single provider into all places a model might live.
 */
const RELATED_PROVIDERS: Record<string, string[]> = {
  'anthropic': ['anthropic'],
  'openai': ['openai', 'openai-codex'],
  'openai-codex': ['openai-codex', 'openai'],
  'google': ['google-antigravity', 'google-gemini-cli', 'google'],
  'google-gemini-cli': ['google-antigravity', 'google-gemini-cli', 'google'],
  'google-antigravity': ['google-antigravity', 'google-gemini-cli', 'google'],
  'github-copilot': ['github-copilot'],
};

const DEBUG = !!process.env['COUNCIL_DEBUG'];

function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[api-adapter] ${msg}\n`);
}

export class ApiAdapter implements InvocationAdapter {
  constructor(private credentialManager: CredentialManager) {}

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
      await throttle(provider);
      const start = Date.now();
      try {
        const model = this.buildCustomModel(config);
        const apiKey = await this.resolveApiKey(config);
        debug(`custom model built: id=${model.id}, baseUrl=${model.baseUrl}, apiKeyLen=${apiKey.length}, customEndpoint=true`);

        const result = onChunk
          ? await this.invokeStreaming(model, prompt, apiKey, config, onChunk)
          : await this.invokeComplete(model, prompt, apiKey, config);

        debug(`result: responseLen=${result.response.length}, tokens=${JSON.stringify(result.token_usage)}, customEndpoint=true`);

        recordSuccess(provider);
        return {
          ...result,
          elapsed_ms: Date.now() - start,
        };
      } catch (err) {
        debug(`error (customEndpoint=true): ${err instanceof Error ? err.message : String(err)}`);
        const is429 = err instanceof Error && (err.message.includes('429') || err.message.includes('rate'));
        recordFailure(provider, is429);
        if (err instanceof InvocationError) throw err;
        throw new InvocationError(
          config.name, 'api',
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const piaiProvider = this.credentialManager.getPiaiProvider(provider);
    debug(`invoke: provider=${provider}, piaiProvider=${piaiProvider}, model=${config.model}, streaming=${!!onChunk}`);

    // Adaptive throttle
    await throttle(provider);

    const start = Date.now();

    try {
      const model = this.resolveModel(piaiProvider, config.model ?? config.name);
      debug(`resolved model: id=${model.id}, provider=${model.provider}, api=${model.api}, baseUrl=${model.baseUrl}`);

      // Get API key matching the resolved model's provider, not the config provider.
      // E.g. config says 'google' but model resolved to 'google-gemini-cli' — use OAuth key.
      const apiKey = await this.credentialManager.getApiKey(model.provider)
        .catch(() => this.credentialManager.getApiKey(provider));
      debug(`apiKey prefix: ${apiKey.substring(0, 12)}...`);

      const result = onChunk
        ? await this.invokeStreaming(model, prompt, apiKey, config, onChunk)
        : await this.invokeComplete(model, prompt, apiKey, config);

      debug(`result: responseLen=${result.response.length}, tokens=${JSON.stringify(result.token_usage)}`);

      recordSuccess(provider);
      return {
        ...result,
        elapsed_ms: Date.now() - start,
      };
    } catch (err) {
      debug(`error: ${err instanceof Error ? err.message : String(err)}`);
      const is429 = err instanceof Error && (err.message.includes('429') || err.message.includes('rate'));
      recordFailure(provider, is429);
      if (err instanceof InvocationError) throw err;
      throw new InvocationError(
        config.name, 'api',
        err instanceof Error ? err.message : String(err),
      );
    }
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
      contextWindow: 8192,
      maxTokens: config.max_tokens ?? 4096,
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

    // 2. Fuzzy match (model ID contains or is contained)
    for (const p of sorted) {
      try {
        const models = getModels(p as KnownProvider);
        const match = models.find(m =>
          m.id === modelId ||
          m.id.includes(modelId) ||
          modelId.includes(m.id),
        );
        if (match) return this.applyOAuthModifications(p, match as Model<Api>);
      } catch { /* provider not found */ }
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
    const textParts: string[] = [];
    const eventStream = streamSimple(model, {
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    }, {
      apiKey,
      maxTokens: config.max_tokens ?? 8192,
      temperature: config.temperature,
      reasoning: config.reasoning_effort,
    });

    let eventCount = 0;
    const eventTypes = new Set<string>();
    for await (const event of eventStream) {
      eventCount++;
      eventTypes.add(event.type);
      if (event.type === 'text_delta') {
        onChunk(event.delta);
        textParts.push(event.delta);
      }
    }
    debug(`stream events: count=${eventCount}, types=[${[...eventTypes].join(',')}], textParts=${textParts.length}`);

    const message = await eventStream.result();
    debug(`stream result: stopReason=${message.stopReason}, contentBlocks=${message.content.length}, types=[${message.content.map(c => c.type).join(',')}]`);
    if (message.errorMessage) debug(`stream errorMessage: ${message.errorMessage}`);

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
      token_usage: {
        input_tokens: message.usage.input,
        output_tokens: message.usage.output,
      },
      timed_out: false,
    };
  }

  private async invokeComplete(
    model: Model<Api>, prompt: string, apiKey: string,
    config: ModelConfig,
  ): Promise<Omit<InvocationResult, 'elapsed_ms'>> {
    debug(`complete: calling completeSimple...`);
    const message = await completeSimple(model, {
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    }, {
      apiKey,
      maxTokens: config.max_tokens ?? 8192,
      temperature: config.temperature,
      reasoning: config.reasoning_effort,
    });
    debug(`complete result: stopReason=${message.stopReason}, contentBlocks=${message.content.length}, types=[${message.content.map(c => c.type).join(',')}]`);
    if (message.errorMessage) debug(`complete errorMessage: ${message.errorMessage}`);

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
      token_usage: {
        input_tokens: message.usage.input,
        output_tokens: message.usage.output,
      },
      timed_out: false,
    };
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
