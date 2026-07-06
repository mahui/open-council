/**
 * Dynamic model discovery — queries each provider's official `/models` endpoint
 * via the vendor SDK when an API key is present (standard-API convergence,
 * design-notes/standard-api-convergence.md §1.5).
 *
 * `ANTHROPIC_API_KEY` present → `@anthropic-ai/sdk` `models.list()`.
 * `OPENAI_API_KEY` present    → `openai` `models.list()`.
 *
 * The live listing reflects the account's actually-accessible models, which is
 * more accurate than any static table. On offline / transient failure we fall
 * back to the hand-maintained static catalog and warn on stderr.
 *
 * Custom / self-hosted endpoints (ollama, vLLM, gateways, Google OpenAI-compat)
 * are listed via {@link discoverEndpointModels}, which takes an explicit
 * base_url + protocol (+ optional key) and — having no static catalog to fall
 * back to — returns [] on failure so the caller drops back to manual id entry.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Protocol } from '../types/config.js';
import type { CredentialManager } from './credentials/discovery.js';
import { MODEL_CATALOG } from '../shared/model-catalog.js';

/** Short timeout for discovery — we never want `/models` to hang startup. */
const DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Placeholder key handed to the SDK for a no-auth custom endpoint (e.g. local
 * Ollama). Must be non-empty: an empty string makes the OpenAI SDK fall back to
 * reading OPENAI_API_KEY from the env (or throw), which would break the very
 * no-auth endpoints we want to list. Mirrors openai-client's NO_AUTH_KEY.
 */
const NO_AUTH_PLACEHOLDER = 'no-auth';

export interface DiscoveredModel {
  id: string;
  name: string;
  protocol: Protocol;
  /** Custom endpoint URL; omitted → the protocol's official endpoint. */
  base_url?: string;
  /** Provenance label used for collision-safe naming (e.g. 'official'). */
  source: string;
}

/**
 * Discover models from every protocol whose official API key resolves via the
 * supplied {@link CredentialManager}. No credentials → empty list (callers fall
 * back to presets/catalog). Credentials are injected (no default parameter) so
 * the sole resolver for official protocol keys stays `resolveOfficialKey`,
 * mirroring ApiAdapter's DI style.
 */
export async function discoverModels(credentials: CredentialManager): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];

  const anthropicKey = credentials.resolveOfficialKey('anthropic');
  if (anthropicKey) {
    models.push(...(await discoverAnthropic(anthropicKey)));
  }

  const openaiKey = credentials.resolveOfficialKey('openai');
  if (openaiKey) {
    models.push(...(await discoverOpenAI(openaiKey)));
  }

  return models;
}

/**
 * List models from a caller-supplied standard-API endpoint (custom base_url:
 * ollama, vLLM, gateways, Google OpenAI-compat…). Mirrors {@link discoverModels}'
 * best-effort contract: on any failure it warns on stderr and returns [] (never
 * throws). A custom endpoint has NO static-catalog fallback, so [] here means
 * "nothing usable discovered" and the caller falls back to manual id entry.
 *
 * Deliberate differences from the official path:
 *  - a no-auth endpoint gets a non-empty placeholder key (see NO_AUTH_PLACEHOLDER);
 *  - the OpenAI `^(gpt-|o[0-9]|chatgpt)` family filter is NOT applied — a custom
 *    endpoint legitimately returns llama/mistral/gemini ids that the filter
 *    would wrongly drop;
 *  - every model carries `base_url` + the caller's `sourceLabel`, so model-assembly's
 *    suffix naming and modelDedupeKey treat it as a distinct custom endpoint.
 */
export async function discoverEndpointModels(opts: {
  protocol: Protocol;
  baseUrl: string;
  apiKey?: string; // omitted/empty → no-auth endpoint (e.g. local ollama)
  sourceLabel: string; // provenance for collision-safe naming; caller-sanitized
}): Promise<DiscoveredModel[]> {
  const { protocol, baseUrl, apiKey, sourceLabel } = opts;
  const key = apiKey && apiKey.length > 0 ? apiKey : NO_AUTH_PLACEHOLDER;

  try {
    if (protocol === 'anthropic') {
      const client = new Anthropic({
        baseURL: baseUrl,
        apiKey: key,
        maxRetries: 0,
        timeout: DISCOVERY_TIMEOUT_MS,
      });
      const page = await client.models.list({ limit: 1000 });
      return page.data.map((m) => ({
        id: m.id,
        name: m.id,
        protocol: 'anthropic' as const,
        base_url: baseUrl,
        source: sourceLabel,
      }));
    }

    const client = new OpenAI({
      baseURL: baseUrl,
      apiKey: key,
      maxRetries: 0,
      timeout: DISCOVERY_TIMEOUT_MS,
    });
    const page = await client.models.list();
    // No family filter here (unlike the official OpenAI path): custom endpoints
    // serve llama3.2 / mistral / gemini-* ids that the gpt/o filter would kill.
    return page.data.map((m) => ({
      id: m.id,
      name: m.id,
      protocol: 'openai' as const,
      base_url: baseUrl,
      source: sourceLabel,
    }));
  } catch (err) {
    warnEndpoint(baseUrl, err);
    return [];
  }
}

async function discoverAnthropic(apiKey: string): Promise<DiscoveredModel[]> {
  try {
    const client = new Anthropic({ apiKey, maxRetries: 0, timeout: DISCOVERY_TIMEOUT_MS });
    const page = await client.models.list({ limit: 1000 });
    const out: DiscoveredModel[] = page.data.map(m => ({
      id: m.id,
      name: m.display_name ?? m.id,
      protocol: 'anthropic' as const,
      source: 'official',
    }));
    return out.length > 0 ? out : staticCatalog('anthropic');
  } catch (err) {
    warnFallback('anthropic', err);
    return staticCatalog('anthropic');
  }
}

async function discoverOpenAI(apiKey: string): Promise<DiscoveredModel[]> {
  try {
    const client = new OpenAI({ apiKey, maxRetries: 0, timeout: DISCOVERY_TIMEOUT_MS });
    const page = await client.models.list();
    // `/models` lists embeddings, TTS, moderation, etc. — keep only chat-capable
    // families (gpt-*, o1/o3/o4 reasoning, chatgpt-*) to avoid flooding the panel.
    const out: DiscoveredModel[] = page.data
      .filter(m => /^(gpt-|o[0-9]|chatgpt)/i.test(m.id))
      .map(m => ({
        id: m.id,
        name: m.id,
        protocol: 'openai' as const,
        source: 'official',
      }));
    return out.length > 0 ? out : staticCatalog('openai');
  } catch (err) {
    warnFallback('openai', err);
    return staticCatalog('openai');
  }
}

/** Fallback suggestion set from the hand-maintained catalog (no live key path). */
function staticCatalog(protocol: Protocol): DiscoveredModel[] {
  const cat = MODEL_CATALOG[protocol];
  return [cat.flagship, cat.balanced, cat.economy].map(m => ({
    id: m.id,
    name: m.displayName,
    protocol,
    source: 'official',
  }));
}

function warnFallback(protocol: Protocol, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `[model-discovery] ${protocol} /models unavailable, using static catalog: ${msg}\n`,
  );
}

/**
 * Custom-endpoint discovery has no static catalog to fall back to, so the
 * warning omits "using static catalog". Only the base_url and the SDK error
 * message are interpolated — never the API key (SEC-02).
 */
function warnEndpoint(baseUrl: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `[model-discovery] endpoint ${baseUrl} /models unavailable: ${msg}\n`,
  );
}
