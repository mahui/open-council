/**
 * Dynamic model discovery — uses pi-ai for API models, detects CLI binaries.
 */

import { getModels } from '@mariozechner/pi-ai';
import type { Api, KnownProvider, Model } from '@mariozechner/pi-ai';
import { getOAuthProvider } from '@mariozechner/pi-ai/oauth';
import type { CredentialManager } from './credentials/discovery.js';
import { hasBinary } from '../shared/env.js';
import { MODEL_CATALOG } from '../shared/model-catalog.js';

export interface DiscoveredModel {
  id: string;
  name: string;
  provider: string;
  /** 'api' = call via pi-ai with credential, 'cli' = call via local binary */
  invocation: 'api' | 'cli';
}

/**
 * Map from OAuth provider IDs to the generic providers whose models should also
 * be listed. E.g. a google-gemini-cli credential can also call models listed
 * under the 'google' provider.
 */
const OAUTH_ALSO_TRY: Record<string, string[]> = {
  'google-gemini-cli': ['google'],
  'google-antigravity': ['google', 'google-vertex'],
  'openai-codex': ['openai'],
  'github-copilot': ['github-copilot'],  // already specific
};

/**
 * Discover available models from all providers with valid credentials.
 * @param enabledProviders Optional whitelist of pi-ai provider IDs (post-expansion).
 *                         Models from providers outside this set are excluded.
 */
export async function discoverModels(
  credentialManager: CredentialManager,
  enabledProviders?: Set<string>,
): Promise<DiscoveredModel[]> {
  const models: DiscoveredModel[] = [];
  const seenIds = new Set<string>();

  // 1. API models from pi-ai — for providers with credentials
  const allAvailable = credentialManager.getAvailableProviders();

  // Apply user filter at the credential-source level; expansion below preserves
  // the OAuth-cred → callable-provider mapping for whatever the user kept.
  const availableProviders = enabledProviders
    ? allAvailable.filter(p => enabledProviders.has(p))
    : allAvailable;

  // Expand OAuth-specific providers to also include generic providers
  const allProviders = new Set<string>(availableProviders);
  for (const p of availableProviders) {
    const also = OAUTH_ALSO_TRY[p];
    if (also) {
      for (const a of also) allProviders.add(a);
    }
  }

  for (const piaiProvider of allProviders) {
    try {
      let providerModels = getModels(piaiProvider as KnownProvider) as Model<Api>[];

      // Apply OAuth provider's modifyModels if available (e.g. GitHub Copilot sets baseUrl)
      const oauthCreds = credentialManager.getOAuthCredentials(piaiProvider);
      if (oauthCreds) {
        const oauthProvider = getOAuthProvider(piaiProvider);
        if (oauthProvider?.modifyModels) {
          providerModels = oauthProvider.modifyModels(providerModels, oauthCreds);
        }
      }

      for (const m of providerModels) {
        const key = `${m.provider}:${m.id}:api`;
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        models.push({
          id: m.id,
          name: m.name,
          provider: m.provider,
          invocation: 'api',
        });
      }
    } catch {
      // Provider not recognized by pi-ai — skip
    }
  }

  // 2. CLI binary discovery (supplementary)
  const cliModels = discoverCliModels();
  for (const m of cliModels) {
    const key = `${m.provider}:${m.id}:cli`;
    if (seenIds.has(key)) continue;
    seenIds.add(key);
    models.push(m);
  }

  return models;
}

function discoverCliModels(): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];

  // Model IDs come from the shared catalog (src/shared/model-catalog.ts) so CLI
  // discovery, MODEL_PRESETS, and discoverModelsFromEnv can never drift apart.
  for (const cat of Object.values(MODEL_CATALOG)) {
    if (!hasBinary(cat.binary)) continue;
    for (const m of cat.cliModels) {
      models.push({
        id: m.id,
        name: `${m.displayName} (CLI)`,
        provider: cat.provider,
        invocation: 'cli',
      });
    }
  }

  return models;
}
