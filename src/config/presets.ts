import type { ModelConfig, Protocol } from '../types/config.js';
import { MODEL_CATALOG } from '../shared/model-catalog.js';

const ANTHROPIC = MODEL_CATALOG.anthropic;
const OPENAI = MODEL_CATALOG.openai;

export interface ModelPreset {
  name: string;
  displayName: string;
  protocol: Protocol;
  provider: string;
  model: string;
  api_key_env: string;
}

// Model IDs are drawn from the shared catalog (src/shared/model-catalog.ts) —
// the single source of truth this file, discoverModelsFromEnv, and
// providers/model-discovery all reference. No hardcoded model-ID literals here.
// Standard-API convergence: only the two official line protocols; no CLI presets.
export const MODEL_PRESETS: ModelPreset[] = [
  // Anthropic
  {
    name: 'claude-opus',
    displayName: ANTHROPIC.flagship.displayName,
    protocol: 'anthropic',
    provider: 'anthropic',
    model: ANTHROPIC.flagship.id,
    api_key_env: ANTHROPIC.apiKeyEnv,
  },
  {
    name: 'claude-sonnet',
    displayName: ANTHROPIC.balanced.displayName,
    protocol: 'anthropic',
    provider: 'anthropic',
    model: ANTHROPIC.balanced.id,
    api_key_env: ANTHROPIC.apiKeyEnv,
  },

  // OpenAI
  {
    name: 'gpt-flagship',
    displayName: OPENAI.flagship.displayName,
    protocol: 'openai',
    provider: 'openai',
    model: OPENAI.flagship.id,
    api_key_env: OPENAI.apiKeyEnv,
  },
  {
    name: 'gpt-mini',
    displayName: OPENAI.balanced.displayName,
    protocol: 'openai',
    provider: 'openai',
    model: OPENAI.balanced.id,
    api_key_env: OPENAI.apiKeyEnv,
  },
];

/**
 * Discover models from environment variables (standard-API convergence:
 * env-var API keys only — no OAuth, no CLI, no Google family). Balanced-tier
 * defaults from the shared catalog so this and MODEL_PRESETS never drift.
 */
export function discoverModelsFromEnv(): ModelConfig[] {
  const models: ModelConfig[] = [];
  const envModels: Array<{ env: string; name: string; protocol: Protocol; provider: string; model: string; priority: number }> = [
    { env: ANTHROPIC.apiKeyEnv, name: 'claude-sonnet', protocol: 'anthropic', provider: 'anthropic', model: ANTHROPIC.balanced.id, priority: 100 },
    { env: OPENAI.apiKeyEnv, name: 'gpt-mini', protocol: 'openai', provider: 'openai', model: OPENAI.balanced.id, priority: 90 },
  ];

  for (const em of envModels) {
    if (process.env[em.env]) {
      models.push({
        name: em.name, protocol: em.protocol, provider: em.provider, model: em.model,
        api_key_env: em.env,
        timeout_seconds: 120, capabilities: ['general', 'code', 'analysis'],
        priority: em.priority, max_concurrent: 1, resource_weight: 1,
        enabled: true, streaming: true,
      });
    }
  }

  return models;
}

export function presetToModelConfig(preset: ModelPreset): ModelConfig {
  return {
    name: preset.name,
    protocol: preset.protocol,
    provider: preset.provider,
    model: preset.model,
    api_key_env: preset.api_key_env,
    timeout_seconds: 120,
    capabilities: ['general'],
    priority: 100,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: true,
  };
}
