/**
 * Model assembly — pure shaping/naming/selection helpers shared by the CLI Setup
 * Wizard (`src/ui/wizard/first-run.ts`) and the Web GUI config server
 * (`src/server`). Extracted here (providers layer) so both can depend downward
 * without ui↔server/commands cycles (design-notes/web-gui-config.md §6).
 *
 * No I/O, no interactive prompts — only discovered-model → ModelConfig shaping,
 * collision-free naming, chairman selection, and custom-endpoint construction.
 */

import { join } from 'node:path';
import type { DiscoveredModel } from './model-discovery.js';
import type { ModelConfig } from '../types/config.js';
import { rateModelCapability } from '../core/role-generator.js';
import { PATHS } from '../config/paths.js';

/** A discovered model paired with the (collision-resolved) name it will be saved under. */
export interface NamedModel {
  model: DiscoveredModel;
  config: ModelConfig;
}

/**
 * Resolve a stable, non-colliding YAML name for each selected model.
 * API and CLI variants can share the same id (e.g. gemini-2.5-pro); left as-is
 * they would write to — and overwrite — the same `<id>.yaml` and duplicate the
 * `prefer` list. Only the CLI variant is suffixed `-cli`, and only when a
 * collision actually exists, so the common single-variant case stays clean.
 */
export function buildNamedModels(models: DiscoveredModel[]): NamedModel[] {
  const idCounts = new Map<string, number>();
  for (const m of models) idCounts.set(m.id, (idCounts.get(m.id) ?? 0) + 1);
  return models.map(m => {
    const collides = (idCounts.get(m.id) ?? 0) > 1;
    const name = collides && m.invocation === 'cli' ? `${m.id}-cli` : m.id;
    return { model: m, config: discoveredToModelConfig(m, name) };
  });
}

/**
 * Pick the strongest model to act as Chairman. The base tier reuses the shared
 * core heuristic ({@link rateModelCapability}); a flagship-id bonus only breaks
 * ties within a tier, so the coarse capability judgement stays in one place.
 */
export function selectBestChairman(configs: ModelConfig[]): ModelConfig | undefined {
  const flagshipBonus = (id: string, invocation: string): number => {
    if (/opus/.test(id)) return 9;
    if (/gpt-5/.test(id)) return 8;
    if (/^o3$/.test(id)) return 7;
    if (/gemini-2\.5-pro/.test(id)) return 6;
    if (/claude-sonnet-4|claude-3-5-sonnet/.test(id)) return 5;
    if (/gpt-4o$/.test(id)) return 4;
    if (/gemini-pro/.test(id)) return 3;
    if (invocation === 'cli') return 1;
    return 0;
  };
  const score = (m: ModelConfig): number => {
    const id = (m.model ?? m.name).toLowerCase();
    return rateModelCapability(m) * 10 + flagshipBonus(id, m.invocation);
  };
  return [...configs].sort((a, b) => score(b) - score(a))[0];
}

/** Shape a discovered model into a persistable ModelConfig under the given name. */
export function discoveredToModelConfig(m: DiscoveredModel, name: string = m.id): ModelConfig {
  const base: ModelConfig = {
    name,
    invocation: m.invocation,
    provider: m.provider,
    model: m.id,
    timeout_seconds: 120,
    capabilities: ['general', 'code', 'analysis'],
    priority: m.provider === 'anthropic' ? 100 : m.provider.startsWith('openai') ? 90 : 80,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: m.invocation === 'api',
  };

  if (m.invocation === 'cli') {
    if (m.provider === 'anthropic') {
      base.binary = 'claude';
      base.args = ['-p', '--model', m.id];
      base.input_mode = 'arg';
    } else if (m.provider === 'openai') {
      base.binary = 'codex';
      base.args = ['exec', '-m', m.id, '-c', 'approval_policy="never"', '--json'];
      base.input_mode = 'arg';
    } else if (m.provider === 'google') {
      base.binary = 'gemini';
      base.args = ['-p'];
      base.input_mode = 'arg';
    }
  }

  return base;
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
 * Shape one model of a custom OpenAI-compatible endpoint into a ModelConfig.
 * `credentialPath` (when present) points at the 0o600 key file — the key itself
 * is never stored in the ModelConfig / YAML (SEC-02).
 */
export function buildCustomModelConfig(opts: {
  sanitizedName: string;
  modelId: string;
  baseUrl: string;
  credentialPath?: string;
}): ModelConfig {
  return {
    name: `custom:${opts.sanitizedName}:${opts.modelId}`,
    invocation: 'api',
    provider: `custom:${opts.sanitizedName}`,
    model: opts.modelId,
    api_base_url: opts.baseUrl,
    api_credential_path: opts.credentialPath,
    timeout_seconds: 120,
    capabilities: ['general', 'code', 'analysis'],
    priority: 50,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: true,
  };
}
