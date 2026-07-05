/**
 * Single source of truth for CLI / fallback default model IDs.
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
 * The IDs are *derived from* @mariozechner/pi-ai's authoritative model catalog:
 * for each tier we list preferred candidate IDs (newest first) and pick the
 * first one pi-ai actually ships, taking pi-ai's own display name. If pi-ai is
 * unavailable (e.g. mocked in a test) we fall back to the first candidate as a
 * static literal so the table is always populated. A guard test asserts every
 * resolved ID is a real pi-ai model ID, so the table can't drift from reality.
 */

import { getModels } from '@mariozechner/pi-ai';
import type { Api, KnownProvider, Model } from '@mariozechner/pi-ai';

export type CatalogProvider = 'anthropic' | 'openai' | 'google';

export interface CatalogModel {
  readonly id: string;
  readonly displayName: string;
}

export interface ProviderCatalog {
  readonly provider: CatalogProvider;
  /** Local CLI binary that serves this provider's models. */
  readonly binary: string;
  /** Environment variable carrying this provider's API key. */
  readonly apiKeyEnv: string;
  /** Top-tier model (opus / flagship gpt / gemini pro). */
  readonly flagship: CatalogModel;
  /** Balanced default model (sonnet / mini / flash). */
  readonly balanced: CatalogModel;
  /** Cheapest/fastest model (haiku / nano / flash-lite). */
  readonly economy: CatalogModel;
  /** Models exposed via CLI discovery, in listing order. */
  readonly cliModels: readonly CatalogModel[];
}

type Tier = 'flagship' | 'balanced' | 'economy';

interface TierSpec {
  /** Candidate pi-ai IDs, most-preferred first. */
  readonly candidates: readonly string[];
  /** Display name used only when pi-ai can't resolve the candidate. */
  readonly fallbackName: string;
}

interface ProviderSpec {
  readonly provider: CatalogProvider;
  readonly piaiProvider: KnownProvider;
  readonly binary: string;
  readonly apiKeyEnv: string;
  readonly flagship: TierSpec;
  readonly balanced: TierSpec;
  readonly economy: TierSpec;
  /** Which tiers appear (in order) as CLI-discoverable models. */
  readonly cliOrder: readonly Tier[];
}

const PROVIDER_SPECS: readonly ProviderSpec[] = [
  {
    provider: 'anthropic',
    piaiProvider: 'anthropic',
    binary: 'claude',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    flagship: { candidates: ['claude-opus-4-6', 'claude-opus-4-5', 'claude-opus-4-1'], fallbackName: 'Claude Opus 4.6' },
    balanced: { candidates: ['claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-0'], fallbackName: 'Claude Sonnet 4.6' },
    economy: { candidates: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'], fallbackName: 'Claude Haiku 4.5' },
    cliOrder: ['balanced', 'flagship'],
  },
  {
    provider: 'openai',
    piaiProvider: 'openai',
    binary: 'codex',
    apiKeyEnv: 'OPENAI_API_KEY',
    flagship: { candidates: ['gpt-5.4', 'gpt-5.2', 'gpt-5.1', 'gpt-5'], fallbackName: 'GPT-5.4' },
    balanced: { candidates: ['gpt-5.4-mini', 'gpt-5-mini'], fallbackName: 'GPT-5.4 mini' },
    economy: { candidates: ['gpt-5.4-nano', 'gpt-5-nano'], fallbackName: 'GPT-5.4 nano' },
    cliOrder: ['flagship', 'balanced'],
  },
  {
    provider: 'google',
    piaiProvider: 'google',
    binary: 'gemini',
    apiKeyEnv: 'GEMINI_API_KEY',
    flagship: { candidates: ['gemini-2.5-pro'], fallbackName: 'Gemini 2.5 Pro' },
    balanced: { candidates: ['gemini-2.5-flash'], fallbackName: 'Gemini 2.5 Flash' },
    economy: { candidates: ['gemini-2.5-flash-lite'], fallbackName: 'Gemini 2.5 Flash Lite' },
    cliOrder: ['flagship', 'balanced'],
  },
];

function safeGetModels(provider: KnownProvider): Model<Api>[] {
  try {
    const models = getModels(provider);
    return Array.isArray(models) ? (models as Model<Api>[]) : [];
  } catch {
    // pi-ai doesn't recognize the provider (or is mocked) — resolve statically.
    return [];
  }
}

function resolveTier(models: Model<Api>[], spec: TierSpec): CatalogModel {
  for (const id of spec.candidates) {
    const match = models.find(m => m.id === id);
    if (match) return { id: match.id, displayName: match.name };
  }
  // pi-ai couldn't resolve any candidate — fall back to the most-preferred literal.
  const fallbackId = spec.candidates[0] ?? '';
  return { id: fallbackId, displayName: spec.fallbackName };
}

function buildCatalog(): Record<CatalogProvider, ProviderCatalog> {
  const out: Partial<Record<CatalogProvider, ProviderCatalog>> = {};
  for (const spec of PROVIDER_SPECS) {
    const models = safeGetModels(spec.piaiProvider);
    const tiers: Record<Tier, CatalogModel> = {
      flagship: resolveTier(models, spec.flagship),
      balanced: resolveTier(models, spec.balanced),
      economy: resolveTier(models, spec.economy),
    };
    out[spec.provider] = {
      provider: spec.provider,
      binary: spec.binary,
      apiKeyEnv: spec.apiKeyEnv,
      flagship: tiers.flagship,
      balanced: tiers.balanced,
      economy: tiers.economy,
      cliModels: spec.cliOrder.map(t => tiers[t]),
    };
  }
  return out as Record<CatalogProvider, ProviderCatalog>;
}

/** Resolved catalog, computed once from pi-ai at module load. */
export const MODEL_CATALOG: Record<CatalogProvider, ProviderCatalog> = buildCatalog();

/** Look up a provider catalog entry by its CLI binary name. */
export function catalogForBinary(binary: string): ProviderCatalog | undefined {
  return Object.values(MODEL_CATALOG).find(c => c.binary === binary);
}

/** Every model ID referenced by the catalog (all tiers, all providers). */
export function catalogModelIds(): Set<string> {
  const ids = new Set<string>();
  for (const cat of Object.values(MODEL_CATALOG)) {
    ids.add(cat.flagship.id);
    ids.add(cat.balanced.id);
    ids.add(cat.economy.id);
  }
  return ids;
}
