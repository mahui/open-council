/**
 * Dynamic model discovery — queries each provider's API/CLI for available models.
 * Follows pi-mono's pattern: all models loaded, then filtered by hasAuth().
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CredentialManager } from './credentials/discovery.js';
import { hasBinary } from './utils.js';

export interface DiscoveredModel {
  id: string;
  name: string;
  provider: 'anthropic' | 'openai' | 'google';
  /** 'api' = call via API with credential, 'cli' = call via local binary */
  invocation: 'api' | 'cli';
}

/** Discover available models from all providers with valid credentials. */
export async function discoverModels(
  credentialManager: CredentialManager,
): Promise<DiscoveredModel[]> {
  const tasks: Array<Promise<DiscoveredModel[]>> = [];

  // API-based discovery (requires credentials)
  if (credentialManager.hasCredential('anthropic')) {
    tasks.push(discoverAnthropicModels(credentialManager));
  }
  if (credentialManager.hasCredential('google')) {
    tasks.push(discoverGoogleModels());
  }

  // CLI-based discovery (checks binary availability)
  // Skip Claude CLI if we already have non-OAuth API access (avoid duplicates)
  const anthropicCred = credentialManager.hasCredential('anthropic')
    ? await credentialManager.getValidCredential('anthropic').catch(() => null)
    : null;
  const anthropicIsOAuth = anthropicCred?.access_token.includes('sk-ant-oat') ?? false;
  tasks.push(discoverCliModels(anthropicIsOAuth));

  const results = await Promise.all(tasks);
  return results.flat();
}

// --- Anthropic: dynamic from /v1/models API ---

async function discoverAnthropicModels(
  credentialManager: CredentialManager,
): Promise<DiscoveredModel[]> {
  try {
    const cred = await credentialManager.getValidCredential('anthropic');
    const isOAuth = cred.access_token.includes('sk-ant-oat');

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };
    if (isOAuth) {
      headers['Authorization'] = `Bearer ${cred.access_token}`;
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    } else {
      headers['x-api-key'] = cred.access_token;
    }

    const res = await fetch('https://api.anthropic.com/v1/models', { headers });
    if (!res.ok) return [];

    const data = await res.json() as { data?: Array<{ id: string; display_name?: string }> };
    let models = (data.data ?? []).filter(m => !m.id.includes('embedding'));

    // OAuth tokens can only call haiku via API; Claude 4+ models return 400.
    // Filter to only models that actually work via API with OAuth.
    if (isOAuth) {
      models = models.filter(m => m.id.includes('haiku'));
    }

    return models.map(m => ({
      id: m.id,
      name: m.display_name ?? m.id,
      provider: 'anthropic' as const,
      invocation: 'api' as const,
    }));
  } catch {
    return [];
  }
}

// --- Google: known models from gemini-cli (Cloud Code Assist API has no list endpoint) ---

async function discoverGoogleModels(): Promise<DiscoveredModel[]> {
  // These are sourced from gemini-cli-core's config/models.js.
  // Cloud Code Assist only supports gemini-2.5+ and gemini-3+ models.
  const knownModels = [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro (Preview)' },
    { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash (Preview)' },
    { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro (Preview)' },
  ];

  return knownModels.map(m => ({
    ...m,
    provider: 'google' as const,
    invocation: 'api' as const,
  }));
}

// --- CLI tools: detect installed binaries and parse their model lists ---

async function discoverCliModels(anthropicIsOAuth: boolean): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];

  if (hasBinary('claude')) {
    // When using OAuth, Claude 4+ models only work via CLI (API returns 400).
    // Always offer CLI models; they'll be preferred over API models that fail.
    models.push(...discoverClaudeCliModels());
  }

  if (hasBinary('codex')) {
    models.push(...discoverCodexCliModels());
  }

  return models;
}

function discoverClaudeCliModels(): DiscoveredModel[] {
  // Claude CLI supports --model flag with any model the account has access to.
  // We use the Anthropic /v1/models API result when available (API path).
  // CLI path is a fallback for models that can't be called via API (e.g. OAuth limitations).
  // We list the latest flagships that are always available via claude -p.
  return [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6 (CLI)', provider: 'anthropic', invocation: 'cli' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6 (CLI)', provider: 'anthropic', invocation: 'cli' },
  ];
}

function discoverCodexCliModels(): DiscoveredModel[] {
  // 1. Try to read current model from ~/.codex/config.toml
  const configModels = parseCodexConfig();

  // 2. If we got models from config, use those + known extras; otherwise use known list
  if (configModels.length > 0) {
    return configModels;
  }

  // Fallback: try parsing `codex --help` output for model hints, or use known defaults
  return parseCodexKnownModels();
}

function parseCodexConfig(): DiscoveredModel[] {
  try {
    const configPath = join(homedir(), '.codex', 'config.toml');
    if (!existsSync(configPath)) return [];

    const content = readFileSync(configPath, 'utf-8');
    const modelMatch = content.match(/^model\s*=\s*"([^"]+)"/m);
    const currentModel = modelMatch?.[1];

    // We know the model from config; also try to list all available from known set
    const known = parseCodexKnownModels();

    // Ensure the configured model is in the list
    if (currentModel && !known.some(m => m.id === currentModel)) {
      known.unshift({
        id: currentModel,
        name: currentModel,
        provider: 'openai',
        invocation: 'cli',
      });
    }

    return known;
  } catch {
    return [];
  }
}

function parseCodexKnownModels(): DiscoveredModel[] {
  // Try to get model list from `codex --help` or similar
  // Codex doesn't have a --list-models command, so we parse from the known set.
  // This list should be updated when codex adds/removes models.
  // The list below is from the user's actual `codex` installation.
  try {
    // Try running codex with an invalid model to see error output with valid models
    const output = execSync('codex -m __invalid__ -c \'approval_policy="never"\' exec "hi" 2>&1', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Parse model names from error output if any
    const models = parseModelsFromOutput(output);
    if (models.length > 0) return models;
  } catch (err) {
    // Try parsing stderr from the error
    const stderr = (err as { stderr?: string })?.stderr ?? '';
    const stdout = (err as { stdout?: string })?.stdout ?? '';
    const models = parseModelsFromOutput(stderr + stdout);
    if (models.length > 0) return models;
  }

  // Hardcoded fallback — last resort
  return [
    { id: 'gpt-5.4', name: 'GPT-5.4', provider: 'openai', invocation: 'cli' },
    { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', provider: 'openai', invocation: 'cli' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', provider: 'openai', invocation: 'cli' },
    { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', provider: 'openai', invocation: 'cli' },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', provider: 'openai', invocation: 'cli' },
    { id: 'gpt-5.2', name: 'GPT-5.2', provider: 'openai', invocation: 'cli' },
    { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', provider: 'openai', invocation: 'cli' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', provider: 'openai', invocation: 'cli' },
  ];
}

function parseModelsFromOutput(output: string): DiscoveredModel[] {
  // Look for model IDs in patterns like "gpt-5.4" or "gpt-5.1-codex-max"
  const modelPattern = /\b(gpt-\d+\.\d+(?:-[\w-]+)?)\b/g;
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];

  let match: RegExpExecArray | null;
  while ((match = modelPattern.exec(output)) !== null) {
    const id = match[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: id,
      provider: 'openai',
      invocation: 'cli',
    });
  }

  return models;
}

// hasBinary imported from ./utils.js (uses execFileSync to avoid command injection)
