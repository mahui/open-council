/**
 * Shared orchestrator assembly — credential discovery, model resolution and
 * adapter construction reused by `council` and `benchmark` commands (ARCH-03/05).
 * Command files stay thin by delegating this boilerplate here.
 */

import type { ModelConfig } from '../../types/config.js';
import { ApiAdapter } from '../../providers/api-adapter.js';
import { CredentialManager } from '../../providers/credentials/discovery.js';
import { ConfigLoader } from '../../config/loader.js';
import { discoverModelsFromEnv } from '../../config/presets.js';
import { formatConfigError } from '../../shared/config-errors.js';
import { PATHS } from '../../config/paths.js';

export interface ResolvedModels {
  models: ModelConfig[];
  /** Default chairman from council.yaml (only when loadGeneralConfig is set). */
  chairman?: string;
  /** Role-panel designer model from council.yaml (only when loadGeneralConfig is set). */
  roleGenModel?: ModelConfig;
  /** Minimum agent seats from council.yaml (only when loadGeneralConfig is set). */
  minAgents?: number;
  /** Maximum agent seats from council.yaml (only when loadGeneralConfig is set). */
  maxAgents?: number;
  /** Ordered model preference from council.yaml routing.default.prefer (only when loadGeneralConfig is set). */
  prefer?: string[];
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
  credentialManager.discoverAll();
  return credentialManager;
}

/**
 * Build the standard-API adapter. Key resolution is centralised in
 * CredentialManager (env var / 0o600 key file, read at invoke time); the adapter
 * delegates to it, so a fresh manager is all it needs.
 */
export function buildAdapter(): ApiAdapter {
  return new ApiAdapter(new CredentialManager());
}

/**
 * Resolve the active model set from the config system, falling back to
 * environment credential discovery.
 */
export function resolveModels(
  options: ResolveModelsOptions = {},
): ResolvedModels {
  const loader = new ConfigLoader();
  let models: ModelConfig[];
  let chairman: string | undefined;
  let roleGenModel: ModelConfig | undefined;
  let minAgents: number | undefined;
  let maxAgents: number | undefined;
  let prefer: string[] | undefined;
  let tuiMode: 'auto' | 'always' | 'never' = 'auto';

  if (loader.isConfigured()) {
    if (options.loadGeneralConfig) {
      try {
        const config = loader.loadCouncilConfig();
        models = loader.loadAllModels();
        chairman = config.general.default_chairman;
        const roleGenName = config.general.role_generator_model;
        if (roleGenName) {
          roleGenModel = models.find(m => m.name === roleGenName);
        }
        minAgents = config.general.min_agents;
        maxAgents = config.general.max_agents;
        prefer = config.routing.default.prefer;
        tuiMode = config.output.tui_mode;
      } catch (err) {
        process.stderr.write(
          '⚠ 配置无法加载，已回落到环境变量发现的模型（可能与你配置的模型不同）。\n',
        );
        process.stderr.write(formatConfigError(err, PATHS.config) + '\n');
        process.stderr.write('  运行 "council setup" 修复配置。\n');
        models = discoverModelsFromEnv();
      }
    } else {
      try {
        models = loader.loadAllModels();
      } catch {
        models = discoverModelsFromEnv();
      }
    }
  } else {
    models = discoverModelsFromEnv();
  }

  return { models, chairman, roleGenModel, minAgents, maxAgents, prefer, tuiMode };
}
