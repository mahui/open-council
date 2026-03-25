import type { ModelConfig } from '../types/config.js';

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

export const MODEL_PRESETS: ModelPreset[] = [
  // Anthropic
  {
    name: 'claude-opus',
    displayName: 'Claude Opus 4',
    provider: 'anthropic',
    model: 'claude-opus-4-20250514',
    invocation: 'api',
    api_key_env: 'ANTHROPIC_API_KEY',
  },
  {
    name: 'claude-sonnet',
    displayName: 'Claude Sonnet 4',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    invocation: 'api',
    api_key_env: 'ANTHROPIC_API_KEY',
  },
  {
    name: 'claude-cli',
    displayName: 'Claude (CLI mode)',
    provider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
    invocation: 'cli',
    binary: 'claude',
    args: ['-p'],
    input_mode: 'arg',
  },

  // OpenAI
  {
    name: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'openai',
    model: 'gpt-4o',
    invocation: 'api',
    api_key_env: 'OPENAI_API_KEY',
  },
  {
    name: 'o4-mini',
    displayName: 'o4-mini',
    provider: 'openai',
    model: 'o4-mini',
    invocation: 'api',
    api_key_env: 'OPENAI_API_KEY',
  },
  {
    name: 'codex-cli',
    displayName: 'Codex (CLI mode)',
    provider: 'openai',
    model: 'o4-mini',
    invocation: 'cli',
    binary: 'codex',
    args: ['-q'],
    input_mode: 'arg',
  },

  // Google
  {
    name: 'gemini-pro',
    displayName: 'Gemini 2.0 Flash',
    provider: 'google',
    model: 'gemini-2.0-flash',
    invocation: 'api',
    api_key_env: 'GEMINI_API_KEY',
  },
  {
    name: 'gemini-cli',
    displayName: 'Gemini (CLI mode)',
    provider: 'google',
    model: 'gemini-2.0-flash',
    invocation: 'cli',
    binary: 'gemini',
    args: ['-p'],
    input_mode: 'arg',
  },
];

/** Discover models from environment variables (Phase 0 fallback). */
export function discoverModelsFromEnv(): ModelConfig[] {
  const models: ModelConfig[] = [];
  const envModels: Array<{ env: string; name: string; provider: ModelConfig['provider']; model: string; priority: number }> = [
    { env: 'ANTHROPIC_API_KEY', name: 'claude-sonnet', provider: 'anthropic', model: 'claude-sonnet-4-20250514', priority: 100 },
    { env: 'OPENAI_API_KEY', name: 'gpt-4o', provider: 'openai', model: 'gpt-4o', priority: 90 },
    { env: 'GEMINI_API_KEY', name: 'gemini-pro', provider: 'google', model: 'gemini-2.0-flash', priority: 80 },
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
