/**
 * Model assembly — pure shaping/naming/selection helpers shared by the CLI Setup
 * Wizard (`src/ui/wizard/first-run.ts`) and the Web GUI config server
 * (`src/server`). Extracted here (providers layer) so both can depend downward
 * without ui↔server/commands cycles (design-notes/web-gui-config.md §6).
 *
 * No I/O, no interactive prompts — only discovered-model → ModelConfig shaping,
 * collision-free naming, chairman selection, and custom-endpoint construction.
 *
 * Standard-API convergence (design-notes/standard-api-convergence.md §1.6): the
 * old provider-family disambiguation is gone. Official anthropic/openai each own
 * a single endpoint, so the only residual collision is "same model id from two
 * different `base_url`s" (an official model and a custom endpoint, or two custom
 * endpoints). Naming therefore collapses to: the official (no `base_url`) source
 * keeps the bare id; other sources get a sanitized source-label suffix; a final
 * `-2/-3` pass guarantees uniqueness.
 */

import { join } from 'node:path';
import type { DiscoveredModel } from './model-discovery.js';
import type { ModelConfig, Protocol } from '../types/config.js';
import { rateModelCapability } from '../shared/model-catalog.js';
import { PATHS } from '../config/paths.js';
import { MODEL_CATALOG } from '../shared/model-catalog.js';

/** A discovered model paired with the (collision-resolved) name it will be saved under. */
export interface NamedModel {
  model: DiscoveredModel;
  config: ModelConfig;
}

/** Lower = more preferred to hold the bare `<id>` name. Official endpoints win. */
function bareNameRank(m: DiscoveredModel): number {
  return m.base_url === undefined ? 0 : 1;
}

/** Append `base`, then `base-2`, `base-3`… until a name not already in `used` is found. */
function uniquify(base: string, used: Set<string>): string {
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}-${n++}`;
  used.add(name);
  return name;
}

/**
 * Assign a stable, collision-free YAML name to each discovered model, preserving
 * input order.
 *
 * When a single id is claimed by multiple sources (an official model and a
 * custom endpoint exposing the same id, or two custom endpoints):
 *  - the official source (best {@link bareNameRank}) keeps the bare `<id>`;
 *  - every other source is suffixed with its sanitized source label
 *    (`<id>-<source>`);
 *  - a final `-2/-3` uniqueness pass guarantees no two models resolve to the
 *    same name, so the `prefer` list and per-model YAML files stay distinct.
 */
export function resolveModelNames(models: DiscoveredModel[]): string[] {
  const idCounts = new Map<string, number>();
  for (const m of models) idCounts.set(m.id, (idCounts.get(m.id) ?? 0) + 1);

  // For each colliding id, elect the single index that keeps the bare name.
  const bareHolder = new Map<string, number>();
  models.forEach((m, i) => {
    if ((idCounts.get(m.id) ?? 0) <= 1) return;
    const cur = bareHolder.get(m.id);
    if (cur === undefined || bareNameRank(m) < bareNameRank(models[cur]!)) {
      bareHolder.set(m.id, i);
    }
  });

  const used = new Set<string>();
  const names = new Array<string>(models.length);

  // Pass 1: bare-name holders (and all non-colliding ids) claim the plain id first.
  models.forEach((m, i) => {
    const collides = (idCounts.get(m.id) ?? 0) > 1;
    if (!collides || bareHolder.get(m.id) === i) {
      names[i] = m.id;
      used.add(m.id);
    }
  });

  // Pass 2: everyone else gets a suffixed, guaranteed-unique name.
  models.forEach((m, i) => {
    if (names[i] !== undefined) return;
    const label = sanitizeProviderName(m.source) || 'custom';
    names[i] = uniquify(`${m.id}-${label}`, used);
  });

  return names;
}

/**
 * Resolve a stable, non-colliding YAML name for each selected model, then shape each
 * into a persistable ModelConfig. Naming is delegated to {@link resolveModelNames}.
 */
export function buildNamedModels(models: DiscoveredModel[]): NamedModel[] {
  const names = resolveModelNames(models);
  return models.map((m, i) => ({ model: m, config: discoveredToModelConfig(m, names[i]!) }));
}

/**
 * Identity key for judging whether two persisted models are "the same" during a
 * rescan upsert. Keyed on (name, base_url) rather than name alone: after custom-
 * endpoint disambiguation two endpoints legitimately produce distinct configs,
 * and a re-import of the same endpoint's model must match its existing entry by
 * *both* fields. Official models (no `base_url`) collapse onto the sentinel
 * `official`.
 */
export function modelDedupeKey(m: { name: string; base_url?: string }): string {
  return `${m.name} ${m.base_url ?? 'official'}`;
}

/**
 * Pick the strongest model to act as Chairman. The base tier reuses the shared
 * core heuristic ({@link rateModelCapability}); a flagship-id bonus only breaks
 * ties within a tier, so the coarse capability judgement stays in one place.
 */
export function selectBestChairman(configs: ModelConfig[]): ModelConfig | undefined {
  const flagshipBonus = (id: string): number => {
    if (/opus/.test(id)) return 9;
    if (/gpt-5/.test(id)) return 8;
    if (/^o3$/.test(id)) return 7;
    if (/gemini-2\.5-pro/.test(id)) return 6;
    if (/claude-sonnet-4|claude-3-5-sonnet/.test(id)) return 5;
    if (/gpt-4o$/.test(id)) return 4;
    if (/gemini-pro/.test(id)) return 3;
    return 0;
  };
  const score = (m: ModelConfig): number => {
    const id = (m.model ?? m.name).toLowerCase();
    return rateModelCapability(m) * 10 + flagshipBonus(id);
  };
  return [...configs].sort((a, b) => score(b) - score(a))[0];
}

/** Shape a discovered model into a persistable ModelConfig under the given name. */
export function discoveredToModelConfig(m: DiscoveredModel, name: string = m.id): ModelConfig {
  const isOfficial = m.base_url === undefined;
  const config: ModelConfig = {
    name,
    protocol: m.protocol,
    model: m.id,
    provider: isOfficial ? m.protocol : m.source,
    timeout_seconds: 120,
    capabilities: ['general', 'code', 'analysis'],
    priority: m.protocol === 'anthropic' ? 100 : 90,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: true,
  };
  if (m.base_url !== undefined) config.base_url = m.base_url;
  // Official endpoints read their key from the protocol's standard env var so the
  // discovered model is runnable without further wiring.
  if (isOfficial) config.api_key_env = MODEL_CATALOG[m.protocol].apiKeyEnv;
  return config;
}

/** Normalise a user-supplied provider name to a filesystem/YAML-safe slug. */
export function sanitizeProviderName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Absolute path of the credential key file for a custom provider (0o600 on write).
 * `baseDir` defaults to the real credentials dir; callers (tests) inject a temp
 * dir to avoid touching the user's `~/.council/credentials`.
 */
export function customCredentialPath(sanitizedName: string, baseDir: string = PATHS.credentials): string {
  return join(baseDir, `custom-${sanitizedName}.key`);
}

/**
 * Shape one model of a custom OpenAI-/Anthropic-compatible endpoint into a
 * ModelConfig. `credentialPath` (when present) points at the 0o600 key file —
 * the key itself is never stored in the ModelConfig / YAML (SEC-02).
 */
export function buildCustomModelConfig(opts: {
  sanitizedName: string;
  modelId: string;
  baseUrl: string;
  protocol?: Protocol;
  credentialPath?: string;
}): ModelConfig {
  const config: ModelConfig = {
    name: `custom:${opts.sanitizedName}:${opts.modelId}`,
    protocol: opts.protocol ?? 'openai',
    provider: `custom:${opts.sanitizedName}`,
    model: opts.modelId,
    base_url: opts.baseUrl,
    timeout_seconds: 120,
    capabilities: ['general', 'code', 'analysis'],
    priority: 50,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: true,
  };
  if (opts.credentialPath !== undefined) config.api_key_path = opts.credentialPath;
  return config;
}
