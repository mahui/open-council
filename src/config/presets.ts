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

import { execSync } from 'node:child_process';

function hasBinary(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Discover models from environment variables, OAuth credentials, and CLI tools (Phase 0 fallback). */
export function discoverModelsFromEnv(credentialManager?: { hasCredential(provider: string): boolean }): ModelConfig[] {
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

  // Also discover models from OAuth credentials (CLI logins)
  if (credentialManager) {
    if (!models.some(m => m.provider === 'anthropic') && credentialManager.hasCredential('anthropic')) {
      // OAuth tokens can only call haiku via API; use CLI for better models
      if (hasBinary('claude')) {
        models.push({
          name: 'claude-sonnet', invocation: 'cli', provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          binary: 'claude',
          args: ['-p', '--model', 'claude-sonnet-4-6'],
          input_mode: 'arg',
          timeout_seconds: 120, capabilities: ['general', 'code', 'analysis'],
          priority: 100, max_concurrent: 1, resource_weight: 1,
          enabled: true, streaming: false,
        });
      } else {
        // No CLI available, fall back to haiku via API (only model that works with OAuth)
        models.push({
          name: 'claude-haiku', invocation: 'api', provider: 'anthropic',
          model: 'claude-haiku-4-5-20251001',
          timeout_seconds: 120, capabilities: ['general', 'code', 'analysis'],
          priority: 100, max_concurrent: 1, resource_weight: 1,
          enabled: true, streaming: true,
        });
      }
    }
    if (!models.some(m => m.provider === 'google') && credentialManager.hasCredential('google')) {
      models.push({
        name: 'gemini-pro', invocation: 'api', provider: 'google',
        model: 'gemini-2.5-flash',  // Cloud Code Assist API supports 2.5 models
        timeout_seconds: 120, capabilities: ['general', 'code', 'analysis'],
        priority: 80, max_concurrent: 1, resource_weight: 1,
        enabled: true, streaming: true,
      });
    }
  }

  // 3. CLI tool discovery — use local CLI tools as fallback
  if (!models.some(m => m.provider === 'openai') && hasBinary('codex')) {
    models.push({
      name: 'codex', invocation: 'cli', provider: 'openai',
      model: 'gpt-5.1-codex-max',
      binary: 'codex',
      args: ['exec', '-m', 'gpt-5.1-codex-max', '-c', 'approval_policy="never"', '--json'],
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
