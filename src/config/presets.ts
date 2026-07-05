import type { ModelConfig } from '../types/config.js';
import { MODEL_CATALOG } from '../shared/model-catalog.js';

const ANTHROPIC = MODEL_CATALOG.anthropic;
const OPENAI = MODEL_CATALOG.openai;
const GOOGLE = MODEL_CATALOG.google;

export interface ModelPreset {
  name: string;
  displayName: string;
  provider: ModelConfig['provider'];
  model: string;
  invocation: ModelConfig['invocation'];
  // CLI fields
  binary?: string;
  args?: string[];
  input_mode?: ModelConfig['input_mode'];
  // API fields
  api_key_env?: string;
}

// Model IDs are drawn from the shared catalog (src/shared/model-catalog.ts) —
// the single source of truth this file, discoverModelsFromEnv, and
// providers/model-discovery all reference. No hardcoded model-ID literals here.
export const MODEL_PRESETS: ModelPreset[] = [
  // Anthropic
  {
    name: 'claude-opus',
    displayName: ANTHROPIC.flagship.displayName,
    provider: 'anthropic',
    model: ANTHROPIC.flagship.id,
    invocation: 'api',
    api_key_env: ANTHROPIC.apiKeyEnv,
  },
  {
    name: 'claude-sonnet',
    displayName: ANTHROPIC.balanced.displayName,
    provider: 'anthropic',
    model: ANTHROPIC.balanced.id,
    invocation: 'api',
    api_key_env: ANTHROPIC.apiKeyEnv,
  },
  {
    name: 'claude-cli',
    displayName: 'Claude (CLI mode)',
    provider: 'anthropic',
    model: ANTHROPIC.balanced.id,
    invocation: 'cli',
    binary: ANTHROPIC.binary,
    args: ['-p'],
    input_mode: 'arg',
  },

  // OpenAI
  {
    name: 'gpt-flagship',
    displayName: OPENAI.flagship.displayName,
    provider: 'openai',
    model: OPENAI.flagship.id,
    invocation: 'api',
    api_key_env: OPENAI.apiKeyEnv,
  },
  {
    name: 'gpt-mini',
    displayName: OPENAI.balanced.displayName,
    provider: 'openai',
    model: OPENAI.balanced.id,
    invocation: 'api',
    api_key_env: OPENAI.apiKeyEnv,
  },
  {
    name: 'codex-cli',
    displayName: 'Codex (CLI mode)',
    provider: 'openai',
    model: OPENAI.flagship.id,
    invocation: 'cli',
    binary: OPENAI.binary,
    args: ['-q'],
    input_mode: 'arg',
  },

  // Google
  {
    name: 'gemini-pro',
    displayName: GOOGLE.flagship.displayName,
    provider: 'google',
    model: GOOGLE.flagship.id,
    invocation: 'api',
    api_key_env: GOOGLE.apiKeyEnv,
  },
  {
    name: 'gemini-cli',
    displayName: 'Gemini (CLI mode)',
    provider: 'google',
    model: GOOGLE.balanced.id,
    invocation: 'cli',
    binary: GOOGLE.binary,
    args: ['-p'],
    input_mode: 'arg',
  },
];

import { hasBinary } from '../shared/env.js';

/** Discover models from environment variables, OAuth credentials, and CLI tools (Phase 0 fallback). */
export function discoverModelsFromEnv(credentialManager?: { hasCredential(provider: string): boolean }): ModelConfig[] {
  const models: ModelConfig[] = [];
  // Balanced-tier defaults from the shared catalog (single source of truth).
  const envModels: Array<{ env: string; name: string; provider: ModelConfig['provider']; model: string; priority: number }> = [
    { env: ANTHROPIC.apiKeyEnv, name: 'claude-sonnet', provider: 'anthropic', model: ANTHROPIC.balanced.id, priority: 100 },
    { env: OPENAI.apiKeyEnv, name: 'gpt-4o', provider: 'openai', model: OPENAI.balanced.id, priority: 90 },
    { env: GOOGLE.apiKeyEnv, name: 'gemini-pro', provider: 'google', model: GOOGLE.balanced.id, priority: 80 },
  ];

  for (const em of envModels) {
    if (process.env[em.env]) {
      models.push({
        name: em.name, invocation: 'api', provider: em.provider, model: em.model,
        timeout_seconds: 120, capabilities: ['general', 'code', 'analysis'],
        priority: em.priority, max_concurrent: 1, resource_weight: 1,
        enabled: true, streaming: true,
      });
    }
  }

  // Also discover models from OAuth credentials (CLI logins)
  if (credentialManager) {
    if (!models.some(m => m.provider === 'anthropic') && credentialManager.hasCredential('anthropic')) {
      // OAuth tokens can only call haiku via API; use CLI for better models
      if (hasBinary(ANTHROPIC.binary)) {
        models.push({
          name: 'claude-sonnet', invocation: 'cli', provider: 'anthropic',
          model: ANTHROPIC.balanced.id,
          binary: ANTHROPIC.binary,
          args: ['-p', '--model', ANTHROPIC.balanced.id],
          input_mode: 'arg',
          timeout_seconds: 120, capabilities: ['general', 'code', 'analysis'],
          priority: 100, max_concurrent: 1, resource_weight: 1,
          enabled: true, streaming: false,
        });
      } else {
        // No CLI available, fall back to the cheapest model (only tier that works with OAuth)
        models.push({
          name: 'claude-haiku', invocation: 'api', provider: 'anthropic',
          model: ANTHROPIC.economy.id,
          timeout_seconds: 120, capabilities: ['general', 'code', 'analysis'],
          priority: 100, max_concurrent: 1, resource_weight: 1,
          enabled: true, streaming: true,
        });
      }
    }
    if (!models.some(m => m.provider === 'google') && credentialManager.hasCredential('google')) {
      models.push({
        name: 'gemini-pro', invocation: 'api', provider: 'google',
        model: GOOGLE.balanced.id,  // Cloud Code Assist API supports 2.5 models
        timeout_seconds: 120, capabilities: ['general', 'code', 'analysis'],
        priority: 80, max_concurrent: 1, resource_weight: 1,
        enabled: true, streaming: true,
      });
    }
  }

  // 3. CLI tool discovery — use local CLI tools as fallback
  if (!models.some(m => m.provider === 'openai') && hasBinary(OPENAI.binary)) {
    models.push({
      name: 'codex', invocation: 'cli', provider: 'openai',
      model: OPENAI.flagship.id,
      binary: OPENAI.binary,
      args: ['exec', '-m', OPENAI.flagship.id, '-c', 'approval_policy="never"', '--json'],
      input_mode: 'arg',
      timeout_seconds: 120, capabilities: ['general', 'code', 'analysis'],
      priority: 90, max_concurrent: 1, resource_weight: 1,
      enabled: true, streaming: false,
    });
  }

  return models;
}

export function presetToModelConfig(preset: ModelPreset): ModelConfig {
  return {
    name: preset.name,
    invocation: preset.invocation,
    provider: preset.provider,
    model: preset.model,
    timeout_seconds: 120,
    capabilities: ['general'],
    priority: 100,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: true,
    // CLI fields
    binary: preset.binary,
    args: preset.args,
    input_mode: preset.input_mode,
    // API fields
    api_key_env: preset.api_key_env,
  };
}
