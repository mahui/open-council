/**
 * Pure model-registry mutations shared by the `council models add/remove/
 * enable/disable` handlers. Each takes an injected {@link ConfigLoader} (so tests
 * point it at a temp dir) and performs one YAML-level change with a discriminated
 * result — no prompts, no `process.exit`, no reliance on the real config dir.
 * Interactive prompting and exit codes live in the command handlers.
 */

import type { ConfigLoader } from '../../config/loader.js';
import type { ModelConfig } from '../../types/config.js';
import { safePath } from '../../shared/paths.js';

/**
 * True when `<name>.yaml` resolves inside `modelsDir` (i.e. `safePath` would NOT
 * throw). Lets the manage commands turn a path-traversal name (`../../evil`) into
 * a friendly one-line error instead of an uncaught `safePath` stack trace.
 * `safePath` stays the security backstop; this is a UX pre-check only. Pure — the
 * caller supplies `modelsDir`, so it's testable without touching the real config.
 */
export function isResolvableModelName(modelsDir: string, name: string): boolean {
  try {
    safePath(modelsDir, `${name}.yaml`);
    return true;
  } catch {
    return false;
  }
}

export type AddResult = { status: 'added' } | { status: 'exists' };

/**
 * Persist a new model config. Refuses to overwrite an existing model of the same
 * name (`status: 'exists'`) so "add" never silently clobbers a hand-tuned model —
 * changing an existing one goes through remove + add or enable/disable.
 */
export function addModelConfig(loader: ConfigLoader, config: ModelConfig): AddResult {
  if (loader.loadModelConfig(config.name) !== null) return { status: 'exists' };
  loader.saveModelConfig(config);
  return { status: 'added' };
}

export type RemoveResult = { status: 'removed' } | { status: 'missing' };

/** Delete a model by name. `missing` when no such model file exists. */
export function removeModelConfig(loader: ConfigLoader, name: string): RemoveResult {
  return loader.deleteModelConfig(name) ? { status: 'removed' } : { status: 'missing' };
}

export type ToggleResult =
  | { status: 'updated'; enabled: boolean }
  | { status: 'noop'; enabled: boolean }
  | { status: 'missing' };

/**
 * Flip a model's `enabled` flag. `missing` when the model doesn't exist; `noop`
 * when it is already in the requested state (no write); `updated` after the flag
 * is persisted.
 */
export function setModelEnabled(loader: ConfigLoader, name: string, enabled: boolean): ToggleResult {
  const config = loader.loadModelConfig(name);
  if (!config) return { status: 'missing' };
  if (config.enabled === enabled) return { status: 'noop', enabled };
  loader.saveModelConfig({ ...config, enabled });
  return { status: 'updated', enabled };
}
