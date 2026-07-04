/**
 * Shared orchestrator assembly — credential discovery, model resolution and
 * adapter construction reused by `council` and `benchmark` commands (ARCH-03/05).
 * Command files stay thin by delegating this boilerplate here.
 */

import type { ModelConfig } from '../../types/config.js';
import { AutoAdapter } from '../../providers/adapter.js';
import { ApiAdapter } from '../../providers/api-adapter.js';
import { CliAdapter } from '../../providers/cli-adapter.js';
import { CredentialManager } from '../../providers/credentials/discovery.js';
import { ConfigLoader } from '../../config/loader.js';
import { discoverModelsFromEnv } from '../../config/presets.js';

export interface ResolvedModels {
  models: ModelConfig[];
  /** Default chairman from council.yaml (only when loadGeneralConfig is set). */
  chairman?: string;
  /** TUI mode from council.yaml, defaults to 'auto'. */
  tuiMode: 'auto' | 'always' | 'never';
}

export interface ResolveModelsOptions {
  /**
   * When true, also load council.yaml to obtain the default chairman and TUI
   * mode, and emit a stderr warning if that config fails to parse (council
   * behaviour). When false, only model YAMLs are loaded and failures fall back
   * to env discovery silently (benchmark behaviour).
   */
  loadGeneralConfig?: boolean;
}

/** Discover all available provider credentials. */
export async function discoverCredentials(): Promise<CredentialManager> {
  const credentialManager = new CredentialManager();
  await credentialManager.discoverAll();
  return credentialManager;
}

/** Build the auto adapter (API-first with CLI fallback) from discovered credentials. */
export function buildAdapter(credentialManager: CredentialManager): AutoAdapter {
  const apiAdapter = new ApiAdapter(credentialManager);
  const cliAdapter = new CliAdapter();
  return new AutoAdapter(apiAdapter, cliAdapter);
}

/**
 * Resolve the active model set from the config system, falling back to
 * environment credential discovery.
 */
export function resolveModels(
  credentialManager: CredentialManager,
  options: ResolveModelsOptions = {},
): ResolvedModels {
  const loader = new ConfigLoader();
  let models: ModelConfig[];
  let chairman: string | undefined;
  let tuiMode: 'auto' | 'always' | 'never' = 'auto';

  if (loader.isConfigured()) {
    if (options.loadGeneralConfig) {
      try {
        const config = loader.loadCouncilConfig();
        models = loader.loadAllModels();
        chairman = config.general.default_chairman;
        tuiMode = config.output.tui_mode;
      } catch (err) {
        process.stderr.write(
          `Warning: config error, falling back to env discovery: ${err instanceof Error ? err.message : err}\n`,
        );
        models = discoverModelsFromEnv(credentialManager);
      }
    } else {
      try {
        models = loader.loadAllModels();
      } catch {
        models = discoverModelsFromEnv(credentialManager);
      }
    }
  } else {
    models = discoverModelsFromEnv(credentialManager);
  }

  return { models, chairman, tuiMode };
}
