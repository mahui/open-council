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
 * back to the hand-maintained static catalog and warn on stderr. Custom
 * OpenAI-compatible endpoints are handled at configuration time (the user types
 * the model id), not here.
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Protocol } from '../types/config.js';
import { MODEL_CATALOG } from '../shared/model-catalog.js';

/** Short timeout for discovery — we never want `/models` to hang startup. */
const DISCOVERY_TIMEOUT_MS = 5_000;

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
 * Discover models from every protocol whose official API key is set in the env.
 * No credentials → empty list (callers fall back to presets/catalog).
 */
export async function discoverModels(): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];

  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  if (anthropicKey) {
    models.push(...(await discoverAnthropic(anthropicKey)));
  }

  const openaiKey = process.env['OPENAI_API_KEY'];
  if (openaiKey) {
    models.push(...(await discoverOpenAI(openaiKey)));
  }

  return models;
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
