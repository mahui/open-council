/**
 * RuntimeConfig — server-private holder of the live orchestration snapshot
 * (design-notes/web-gui-config.md §5).
 *
 * `serve.ts` resolves models/chairman/adapter once at boot and hands them here.
 * DebateManager and the routes read the CURRENT snapshot at request time (never
 * a value captured at construction), so a config write followed by `reload*`
 * takes effect on the next debate — while any in-flight debate keeps the older
 * snapshot it already captured in its Orchestrator (correct: models must not
 * change mid-debate).
 *
 * No core changes; depends only downward on config + providers layers.
 */

import type { InvocationAdapter } from '../types/provider.js';
import type { ModelConfig } from '../types/config.js';
import { ApiAdapter } from '../providers/api-adapter.js';
import { CredentialManager } from '../providers/credentials/discovery.js';
import type { ConfigLoader } from '../config/loader.js';

export interface RuntimeSnapshot {
  /** Standard-API invocation adapter. */
  adapter: InvocationAdapter;
  /** Enabled model set — feeds orchestration (disabled models never debate). */
  models: ModelConfig[];
  /** Full model set incl. disabled — feeds the /api/config projection. */
  allModels: ModelConfig[];
  /** Default chairman name from council.yaml ('' → orchestrator auto-picks). */
  defaultChairman: string;
  /** Optional role-panel designer model resolved from council.yaml. */
  roleGenModel?: ModelConfig;
  /** Minimum agent seats for compare/debate (config general.min_agents). */
  minAgents: number;
  /** Maximum agent seats for all multi-agent modes (config general.max_agents). */
  maxAgents: number;
  /** Ordered model preference (config routing.default.prefer) — drives role-gen candidate ordering. */
  preferOrder: string[];
}

export class RuntimeConfig {
  constructor(private snap: RuntimeSnapshot) {}

  /** The current snapshot — read at request time, never cached by callers. */
  get current(): RuntimeSnapshot {
    return this.snap;
  }

  /** Atomically swap in a freshly-built snapshot after a config write. */
  replace(next: RuntimeSnapshot): void {
    this.snap = next;
  }
}

/**
 * Build the standard-API adapter. Key resolution is centralised in
 * CredentialManager (env var / 0o600 key file, read at invoke time); the adapter
 * delegates to it, so a fresh manager is all it needs.
 */
export function buildAutoAdapter(): InvocationAdapter {
  return new ApiAdapter(new CredentialManager());
}

/**
 * Build a snapshot from the current on-disk config. Reuses `adapter` when given
 * (PUT/PATCH/custom-endpoint writes don't touch credentials — custom keys are
 * read from disk at invoke time), and rebuilds it from `credentialManager` only
 * when the caller passes a fresh one (rescan may have picked up new creds).
 */
export function buildSnapshot(opts: {
  loader: ConfigLoader;
  credentialManager: CredentialManager;
  adapter?: InvocationAdapter;
}): RuntimeSnapshot {
  const allModels = opts.loader.loadAllModelConfigs();
  const models = allModels.filter(m => m.enabled);
  const config = opts.loader.loadCouncilConfigSafe();
  const defaultChairman = config?.general.default_chairman ?? '';
  const roleGenName = config?.general.role_generator_model;
  const roleGenModel = roleGenName ? models.find(m => m.name === roleGenName) : undefined;
  const minAgents = config?.general.min_agents ?? 2;
  const maxAgents = config?.general.max_agents ?? 5;
  const preferOrder = config?.routing.default.prefer ?? [];
  const adapter = opts.adapter ?? buildAutoAdapter();
  return { adapter, models, allModels, defaultChairman, roleGenModel, minAgents, maxAgents, preferOrder };
}

/**
 * Rebuild the snapshot in place after a config write.
 * `rebuildAdapter` is only set by rescan (new credentials may exist); ordinary
 * config edits keep the existing adapter (SEC-02: custom keys re-read at invoke).
 */
export function reloadRuntime(
  runtime: RuntimeConfig,
  loader: ConfigLoader,
  credentialManager: CredentialManager,
  opts: { rebuildAdapter?: boolean } = {},
): void {
  const adapter = opts.rebuildAdapter ? buildAutoAdapter() : runtime.current.adapter;
  runtime.replace(buildSnapshot({ loader, credentialManager, adapter }));
}
