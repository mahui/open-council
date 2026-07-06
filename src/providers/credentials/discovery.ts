import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { getEnvApiKey } from '@mariozechner/pi-ai';

const DEBUG = !!process.env['COUNCIL_DEBUG'];
function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[credentials] ${msg}\n`);
}
import type { OAuthCredentials, OAuthLoginCallbacks } from '@mariozechner/pi-ai';
import { getOAuthProvider, getOAuthProviders, getOAuthApiKey } from '@mariozechner/pi-ai/oauth';
import type { DiscoveryReport } from '../../types/provider.js';
import { CredentialNotFoundError } from '../../types/errors.js';
import { PATHS, KNOWN_CREDENTIALS } from '../../config/paths.js';

/**
 * Maps legacy/config provider names to the pi-ai provider IDs whose cached credentials
 * can serve them. `google-vertex` is listed both as a member of the `google` family and
 * as its own key so a model saved with `provider: google-vertex` resolves onto the shared
 * Google OAuth credential (Vertex ships no dedicated cred here). Keep in sync with the
 * call-time RELATED_PROVIDERS table in api-adapter.ts.
 */
export const LEGACY_TO_PIAI: Record<string, string[]> = {
  'anthropic': ['anthropic'],
  'openai': ['openai', 'openai-codex'],
  'google': ['google', 'google-gemini-cli', 'google-antigravity', 'google-vertex'],
  'google-vertex': ['google-vertex', 'google', 'google-gemini-cli', 'google-antigravity'],
};

/** Reverse: pi-ai provider → legacy provider name */
const PIAI_TO_LEGACY: Record<string, string> = {
  'anthropic': 'anthropic',
  'openai': 'openai',
  'openai-codex': 'openai',
  'google': 'google',
  'google-gemini-cli': 'google',
  'google-antigravity': 'google',
  'google-vertex': 'google',
  'github-copilot': 'github-copilot',
};

interface CachedCredential {
  apiKey: string;
  source: 'env' | 'oauth' | 'legacy-file';
  piaiProvider: string;  // pi-ai provider ID
  oauthCredentials?: OAuthCredentials;
}

export class CredentialManager {
  private cache = new Map<string, CachedCredential>();

  /**
   * Discover all available credentials from env vars, OAuth storage, and legacy files.
   * Returns a report compatible with the existing DiscoveryReport format.
   */
  async discoverAll(): Promise<DiscoveryReport> {
    const results: DiscoveryReport = {};

    // 1. Environment variables via pi-ai
    this.discoverEnvKeys(results);

    // 2. Stored OAuth credentials (from previous login or other CLI tools)
    await this.discoverOAuthCredentials(results);

    // 3. Legacy file-based credentials (codex auth.json, gemini oauth_creds.json, keychain)
    await this.discoverLegacyCredentials(results);

    // Debug: dump cache state
    if (DEBUG) {
      for (const [key, val] of this.cache) {
        debug(`cache: ${key} → source=${val.source}, piaiProvider=${val.piaiProvider}, hasOAuth=${!!val.oauthCredentials}, keyPrefix=${val.apiKey.substring(0, 12)}...`);
      }
    }

    return results;
  }

  /** Get a usable API key for a provider. Handles refresh automatically. */
  async getApiKey(provider: string): Promise<string> {
    // Try direct match first
    let cred = this.cache.get(provider);

    // If not found, try pi-ai provider names that map to this legacy provider
    if (!cred) {
      const piaiProviders = LEGACY_TO_PIAI[provider] ?? [provider];
      for (const pp of piaiProviders) {
        cred = this.cache.get(pp);
        if (cred) break;
      }
    }

    if (!cred) throw new CredentialNotFoundError(provider);

    // If it's an OAuth credential, use pi-ai to refresh if needed
    if (cred.source === 'oauth' && cred.oauthCredentials) {
      const oauthProvider = getOAuthProvider(cred.piaiProvider);
      if (oauthProvider) {
        const allCreds: Record<string, OAuthCredentials> = {};
        allCreds[cred.piaiProvider] = cred.oauthCredentials;
        const result = await getOAuthApiKey(cred.piaiProvider, allCreds);
        if (result) {
          cred.apiKey = result.apiKey;
          cred.oauthCredentials = result.newCredentials;
          this.saveOAuthCredentials(cred.piaiProvider, result.newCredentials);
        }
      }
    }

    return cred.apiKey;
  }

  /** Check if credentials exist for a provider (legacy or pi-ai name). */
  hasCredential(provider: string): boolean {
    if (this.cache.has(provider)) return true;
    const piaiProviders = LEGACY_TO_PIAI[provider] ?? [provider];
    return piaiProviders.some(pp => this.cache.has(pp));
  }

  /** Get the pi-ai provider ID for a given legacy provider name. */
  getPiaiProvider(provider: string): string {
    const cred = this.cache.get(provider);
    if (cred) return cred.piaiProvider;
    const piaiProviders = LEGACY_TO_PIAI[provider] ?? [provider];
    for (const pp of piaiProviders) {
      if (this.cache.has(pp)) return pp;
    }
    return provider;
  }

  /** Get all available pi-ai provider IDs that have credentials. */
  getAvailableProviders(): string[] {
    return [...new Set([...this.cache.values()].map(c => c.piaiProvider))];
  }

  /** Get raw OAuth credentials for a provider (used by modifyModels). */
  getOAuthCredentials(provider: string): OAuthCredentials | undefined {
    const cred = this.cache.get(provider);
    if (cred?.oauthCredentials) return cred.oauthCredentials;
    // Try legacy mapping
    const piaiProviders = LEGACY_TO_PIAI[provider] ?? [provider];
    for (const pp of piaiProviders) {
      const c = this.cache.get(pp);
      if (c?.oauthCredentials) return c.oauthCredentials;
    }
    return undefined;
  }

  /** Get the credential source for a specific cached provider entry (no legacy mapping). */
  getDirectSource(provider: string): 'env' | 'oauth' | 'legacy-file' | undefined {
    return this.cache.get(provider)?.source;
  }

  /**
   * Run OAuth login for a provider via pi-ai.
   * Returns the OAuthCredentials on success, persists them locally.
   */
  async login(oauthProviderId: string, callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const provider = getOAuthProvider(oauthProviderId);
    if (!provider) throw new Error(`Unknown OAuth provider: ${oauthProviderId}`);

    const credentials = await provider.login(callbacks);
    this.saveOAuthCredentials(oauthProviderId, credentials);

    // Cache the credential
    const apiKey = provider.getApiKey(credentials);
    const legacyProvider = PIAI_TO_LEGACY[oauthProviderId] ?? oauthProviderId;
    this.cache.set(legacyProvider, {
      apiKey,
      source: 'oauth',
      piaiProvider: oauthProviderId,
      oauthCredentials: credentials,
    });
    // Also cache under pi-ai provider ID
    if (legacyProvider !== oauthProviderId) {
      this.cache.set(oauthProviderId, {
        apiKey,
        source: 'oauth',
        piaiProvider: oauthProviderId,
        oauthCredentials: credentials,
      });
    }

    return credentials;
  }

  /** Get available OAuth providers from pi-ai that the user can log into. */
  getLoginableProviders(): Array<{ id: string; name: string }> {
    return getOAuthProviders().map(p => ({ id: p.id, name: p.name }));
  }

  // --- Private discovery methods ---

  private discoverEnvKeys(results: DiscoveryReport): void {
    // pi-ai knows which env vars each provider uses
    const providers = ['anthropic', 'openai', 'google', 'xai', 'groq', 'mistral'] as const;
    for (const provider of providers) {
      const key = getEnvApiKey(provider);
      if (key) {
        const legacyProvider = PIAI_TO_LEGACY[provider] ?? provider;
        results[legacyProvider] = { source: 'env', status: 'valid' };
        this.cache.set(legacyProvider, {
          apiKey: key,
          source: 'env',
          piaiProvider: provider,
        });
        // Also cache under pi-ai provider ID
        if (legacyProvider !== provider) {
          this.cache.set(provider, {
            apiKey: key,
            source: 'env',
            piaiProvider: provider,
          });
        }
      }
    }
  }

  private async discoverOAuthCredentials(results: DiscoveryReport): Promise<void> {
    const oauthProviders = getOAuthProviders();

    for (const provider of oauthProviders) {
      const legacyProvider = PIAI_TO_LEGACY[provider.id] ?? provider.id;
      // Skip only if the exact same pi-ai provider already has credentials cached.
      // Don't skip when a *different* provider shares the legacy name (e.g. env 'google'
      // should not block OAuth 'google-gemini-cli').
      if (this.cache.has(provider.id)) continue;

      // Try loading stored OAuth credentials
      const creds = this.loadOAuthCredentials(provider.id);
      if (!creds) continue;

      try {
        const allCreds: Record<string, OAuthCredentials> = { [provider.id]: creds };
        const result = await getOAuthApiKey(provider.id, allCreds);
        if (result) {
          // Always cache under the specific pi-ai provider ID
          this.cache.set(provider.id, {
            apiKey: result.apiKey,
            source: 'oauth',
            piaiProvider: provider.id,
            oauthCredentials: result.newCredentials,
          });
          // Also cache under legacy name if no env key already occupies it
          if (legacyProvider !== provider.id && !this.cache.has(legacyProvider)) {
            this.cache.set(legacyProvider, {
              apiKey: result.apiKey,
              source: 'oauth',
              piaiProvider: provider.id,
              oauthCredentials: result.newCredentials,
            });
          }
          // Persist refreshed credentials
          if (result.newCredentials !== creds) {
            this.saveOAuthCredentials(provider.id, result.newCredentials);
          }
          results[provider.id] = {
            source: 'file',
            status: result.newCredentials !== creds ? 'refreshed' : 'valid',
            path: this.oauthCredentialPath(provider.id),
          };
        }
      } catch {
        results[provider.id] = {
          source: 'file',
          status: 'expired',
          path: this.oauthCredentialPath(provider.id),
        };
      }
    }
  }

  private async discoverLegacyCredentials(results: DiscoveryReport): Promise<void> {
    // OpenAI (codex auth.json) → convert to pi-ai OAuth format
    if (!this.cache.has('openai-codex')) {
      const creds = this.readCodexAuthFile();
      if (creds) {
        try {
          const oauthProvider = getOAuthProvider('openai-codex');
          if (oauthProvider) {
            const apiKey = oauthProvider.getApiKey(creds);
            this.cache.set('openai-codex', {
              apiKey,
              source: 'oauth',
              piaiProvider: 'openai-codex',
              oauthCredentials: creds,
            });
            if (!this.cache.has('openai')) {
              this.cache.set('openai', {
                apiKey,
                source: 'oauth',
                piaiProvider: 'openai-codex',
                oauthCredentials: creds,
              });
            }
            results['openai-codex'] = { source: 'file', status: 'valid', path: KNOWN_CREDENTIALS.openai };
          }
        } catch {
          results['openai-codex'] = { source: 'file', status: 'parse_error', path: KNOWN_CREDENTIALS.openai };
        }
      }
    }

    // Google (gemini CLI oauth_creds.json) → convert to pi-ai OAuth format
    if (!this.cache.has('google-gemini-cli')) {
      const creds = this.readGeminiOAuthFile();
      if (creds) {
        try {
          // Discover projectId — required for Cloud Code Assist API routing
          const projectId = await this.discoverGoogleProjectId(creds.access);
          if (projectId) {
            creds.projectId = projectId;
            debug(`google-gemini-cli: attached projectId=${projectId}`);
          } else {
            debug(`google-gemini-cli: no projectId found, API calls may fail`);
          }

          const oauthProvider = getOAuthProvider('google-gemini-cli');
          if (oauthProvider) {
            const apiKey = oauthProvider.getApiKey(creds);
            debug(`google-gemini-cli: apiKey=${apiKey.substring(0, 40)}...`);
            this.cache.set('google-gemini-cli', {
              apiKey,
              source: 'oauth',
              piaiProvider: 'google-gemini-cli',
              oauthCredentials: creds,
            });
            // Also register under google-antigravity (same creds, different endpoint/capacity pool)
            const antigravityProvider = getOAuthProvider('google-antigravity');
            debug(`google-antigravity: provider lookup = ${antigravityProvider ? 'found' : 'NOT FOUND'}`);
            if (antigravityProvider) {
              try {
                const agApiKey = antigravityProvider.getApiKey(creds);
                this.cache.set('google-antigravity', {
                  apiKey: agApiKey,
                  source: 'oauth',
                  piaiProvider: 'google-antigravity',
                  oauthCredentials: creds,
                });
                debug(`google-antigravity: registered`);
              } catch (agErr) {
                debug(`google-antigravity: getApiKey failed: ${agErr instanceof Error ? agErr.message : agErr}`);
              }
            }
            // Fallback: if pi-ai doesn't have antigravity provider, construct apiKey manually
            // (same JSON format as google-gemini-cli)
            if (!this.cache.has('google-antigravity')) {
              this.cache.set('google-antigravity', {
                apiKey,  // same as google-gemini-cli's apiKey: {"token":"...","projectId":"..."}
                source: 'oauth',
                piaiProvider: 'google-antigravity',
                oauthCredentials: creds,
              });
              debug(`google-antigravity: registered via fallback (same apiKey as gemini-cli)`);
            }
            if (!this.cache.has('google')) {
              this.cache.set('google', {
                apiKey,
                source: 'oauth',
                piaiProvider: 'google-gemini-cli',
                oauthCredentials: creds,
              });
            }
            results['google-gemini-cli'] = { source: 'file', status: 'valid', path: KNOWN_CREDENTIALS.google };
            results['google-antigravity'] = { source: 'file', status: 'valid', path: KNOWN_CREDENTIALS.google };
          }
        } catch (err) {
          debug(`google-gemini-cli: error ${err instanceof Error ? err.message : err}`);
          results['google-gemini-cli'] = { source: 'file', status: 'parse_error', path: KNOWN_CREDENTIALS.google };
        }
      }
    }

    // Anthropic (macOS Keychain — Claude Code OAuth)
    if (!results['anthropic'] && process.platform === 'darwin') {
      const creds = this.readClaudeCodeKeychain();
      if (creds) {
        try {
          const oauthProvider = getOAuthProvider('anthropic');
          if (oauthProvider) {
            const apiKey = oauthProvider.getApiKey(creds);
            this.cache.set('anthropic', {
              apiKey,
              source: 'oauth',
              piaiProvider: 'anthropic',
              oauthCredentials: creds,
            });
            results['anthropic'] = { source: 'file', status: 'valid', path: 'keychain:Claude Code-credentials' };
          }
        } catch {
          results['anthropic'] = { source: 'file', status: 'expired', path: 'keychain:Claude Code-credentials' };
        }
      }
    }
  }

  // --- OAuth credential persistence ---

  private oauthCredentialPath(providerId: string): string {
    return join(PATHS.credentials, `${providerId}.json`);
  }

  private loadOAuthCredentials(providerId: string): OAuthCredentials | null {
    const path = this.oauthCredentialPath(providerId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as OAuthCredentials;
    } catch {
      return null;
    }
  }

  private saveOAuthCredentials(providerId: string, credentials: OAuthCredentials): void {
    mkdirSync(PATHS.credentials, { recursive: true, mode: 0o700 });
    const path = this.oauthCredentialPath(providerId);
    writeFileSync(path, JSON.stringify(credentials, null, 2), { mode: 0o600 });
  }

  // --- Legacy file readers (convert to pi-ai OAuthCredentials format) ---

  private readCodexAuthFile(): OAuthCredentials | null {
    const path = KNOWN_CREDENTIALS.openai;
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      const tokens = raw['tokens'] as Record<string, unknown> | undefined;
      if (!tokens?.['access_token']) return null;
      return {
        access: tokens['access_token'] as string,
        refresh: (tokens['refresh_token'] as string) ?? '',
        expires: (tokens['expires_at'] as number) ?? 0,
        account_id: tokens['account_id'] as string | undefined,
      };
    } catch {
      return null;
    }
  }

  private readGeminiOAuthFile(): OAuthCredentials | null {
    const path = KNOWN_CREDENTIALS.google;
    if (!existsSync(path)) return null;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
      if (!raw['access_token']) return null;
      return {
        access: raw['access_token'] as string,
        refresh: (raw['refresh_token'] as string) ?? '',
        expires: (raw['expiry_date'] as number) ?? 0,
        // projectId will be discovered async in discoverLegacyCredentials
      };
    } catch {
      return null;
    }
  }

  /**
   * Discover the Google Cloud project ID for Cloud Code Assist.
   * This is required for the google-gemini-cli provider to route requests
   * to the correct subscription/quota.
   */
  private async discoverGoogleProjectId(accessToken: string): Promise<string | null> {
    try {
      const res = await fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: '{}',
      });
      if (!res.ok) {
        debug(`discoverGoogleProjectId: loadCodeAssist failed ${res.status}`);
        return null;
      }
      const data = await res.json() as { cloudaicompanionProject?: string };
      const projectId = data.cloudaicompanionProject ?? null;
      debug(`discoverGoogleProjectId: found ${projectId}`);
      return projectId;
    } catch (err) {
      debug(`discoverGoogleProjectId: error ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private readClaudeCodeKeychain(): OAuthCredentials | null {
    try {
      const raw = execSync(
        'security find-generic-password -s "Claude Code-credentials" -w',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();

      const data = JSON.parse(raw) as {
        claudeAiOauth?: {
          accessToken?: string;
          refreshToken?: string;
          expiresAt?: number;
        };
      };

      const oauth = data.claudeAiOauth;
      if (!oauth?.accessToken) return null;

      return {
        access: oauth.accessToken,
        refresh: oauth.refreshToken ?? '',
        expires: oauth.expiresAt ?? 0,
      };
    } catch {
      return null;
    }
  }
}
