/**
 * Single source of truth for fallback default model IDs.
 *
 * Historically three places hardcoded their own model IDs
 * (providers/model-discovery.ts, config/presets.ts MODEL_PRESETS, and
 * config/presets.ts discoverModelsFromEnv) and they drifted apart — users could
 * silently end up running a different set of models depending on which fallback
 * path fired. This module is the ONE table all three now reference.
 *
 * Placement: `src/shared/` (zero project-internal deps) so both `src/config/`
 * and `src/providers/` can import it without reintroducing the config→providers
 * reverse dependency that was previously removed.
 *
 * The IDs are a plain, hand-maintained literal table (standard-API convergence,
 * design-notes/standard-api-convergence.md §1.7). It is used only as an offline
 * / no-key fallback suggestion; **when an API key is present, the live
 * `/models` endpoint (see providers/model-discovery.ts) is authoritative** and
 * this table is not consulted. When a vendor ships new flagship IDs, edit the
 * literals below by hand.
 */

import type { Protocol, ModelConfig } from '../types/config.js';

/** The two line protocols we ship a fallback catalog for. */
export type CatalogProvider = Protocol;

export interface CatalogModel {
  readonly id: string;
  readonly displayName: string;
}

export interface ProviderCatalog {
  /** Line protocol / SDK client this catalog entry targets. */
  readonly protocol: Protocol;
  /** Environment variable carrying this protocol's official API key. */
  readonly apiKeyEnv: string;
  /** Top-tier model (opus / flagship gpt). */
  readonly flagship: CatalogModel;
  /** Balanced default model (sonnet / mini). */
  readonly balanced: CatalogModel;
  /** Cheapest/fastest model (haiku / nano). */
  readonly economy: CatalogModel;
}

/**
 * Hardcoded fallback catalog. Hand-maintained; see the file header. Only the two
 * official line protocols appear — custom OpenAI-compatible endpoints supply
 * their own model ids at configuration time.
 */
export const MODEL_CATALOG: Record<CatalogProvider, ProviderCatalog> = {
  anthropic: {
    protocol: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    flagship: { id: 'claude-opus-4-6', displayName: 'Claude Opus 4.6' },
    balanced: { id: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6' },
    economy: { id: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5' },
  },
  openai: {
    protocol: 'openai',
    apiKeyEnv: 'OPENAI_API_KEY',
    flagship: { id: 'gpt-5.4', displayName: 'GPT-5.4' },
    balanced: { id: 'gpt-5.4-mini', displayName: 'GPT-5.4 mini' },
    economy: { id: 'gpt-5.4-nano', displayName: 'GPT-5.4 nano' },
  },
};

/** Every model ID referenced by the catalog (all tiers, all protocols). */
export function catalogModelIds(): Set<string> {
  const ids = new Set<string>();
  for (const cat of Object.values(MODEL_CATALOG)) {
    ids.add(cat.flagship.id);
    ids.add(cat.balanced.id);
    ids.add(cat.economy.id);
  }
  return ids;
}

/**
 * Coarse capability tier inferred from a model's id/name.
 * 3 = strong reasoning, 2 = balanced (also the default for unrecognized ids),
 * 1 = fast/lightweight. Reusable across chairman selection (strongest wins),
 * role-panel designer selection (prefer balanced), and model descriptions.
 */
export function rateModelCapability(m: ModelConfig): number {
  const id = m.model ?? m.name;
  if (/opus|pro|5\.[3-9]|o[34]/i.test(id)) return 3;
  if (/sonnet|flash|gpt-[45]/i.test(id)) return 2;
  if (/haiku|mini|lite|spark/i.test(id)) return 1;
  return 2;
}
