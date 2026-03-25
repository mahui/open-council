import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderCredential, DiscoveryReport } from '../../types/provider.js';
import { CredentialNotFoundError, CredentialExpiredError } from '../../types/errors.js';

const CREDENTIAL_PATHS: Record<string, string> = {
  openai:    join(homedir(), '.codex', 'auth.json'),
  google:    join(homedir(), '.gemini', 'oauth_creds.json'),
  'google-vertex': join(homedir(), '.config', 'gcloud', 'application_default_credentials.json'),
};

const TOKEN_ENDPOINTS: Record<string, string> = {
  anthropic: 'https://platform.claude.com/v1/oauth/token',
  openai:    'https://auth.openai.com/oauth/token',
  google:    'https://oauth2.googleapis.com/token',
};

const OPENAI_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

const ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GEMINI_API_KEY',
};

export class CredentialManager {
  private cache = new Map<string, ProviderCredential>();

  async discoverAll(): Promise<DiscoveryReport> {
    const results: DiscoveryReport = {};

    // 1. Environment variables take priority
    for (const [provider, envVar] of Object.entries(ENV_VARS)) {
      const key = process.env[envVar];
      if (key) {
        results[provider] = {
          source: 'env',
          status: 'valid',
          env_var: envVar,
        };
        this.cache.set(provider, { access_token: key, source: 'env' });
      }
    }

    // 2. Local credential files
    for (const [provider, path] of Object.entries(CREDENTIAL_PATHS)) {
      if (results[provider]) continue;
      if (!existsSync(path)) {
        results[provider] = { source: 'file', status: 'not_found', path };
        continue;
      }

      try {
        const credential = this.parseCredentialFile(provider, path);
        if (this.isExpired(credential)) {
          const refreshed = await this.refreshToken(provider, credential);
          if (refreshed) {
            this.writeBackCredential(provider, path, refreshed);
            this.cache.set(provider, refreshed);
            results[provider] = { source: 'file', status: 'refreshed', path };
          } else {
            results[provider] = { source: 'file', status: 'expired', path };
          }
        } else {
          this.cache.set(provider, credential);
          results[provider] = { source: 'file', status: 'valid', path };
        }
      } catch {
        results[provider] = { source: 'file', status: 'parse_error', path };
      }
    }

    return results;
  }

  async getValidCredential(provider: string): Promise<ProviderCredential> {
    let cred = this.cache.get(provider);
    if (!cred) throw new CredentialNotFoundError(provider);

    if (this.isExpired(cred) && cred.refresh_token) {
      const refreshed = await this.refreshToken(provider, cred);
      if (!refreshed) throw new CredentialExpiredError(provider);
      cred = refreshed;
      this.cache.set(provider, cred);
    }

    return cred;
  }

  hasCredential(provider: string): boolean {
    return this.cache.has(provider);
  }

  setCredential(provider: string, credential: ProviderCredential): void {
    this.cache.set(provider, credential);
  }

  private parseCredentialFile(provider: string, path: string): ProviderCredential {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;

    switch (provider) {
      case 'openai': {
        const tokens = raw['tokens'] as Record<string, unknown> | undefined;
        return {
          access_token: (tokens?.['access_token'] as string) ?? '',
          refresh_token: tokens?.['refresh_token'] as string | undefined,
          account_id: tokens?.['account_id'] as string | undefined,
          expires_at: tokens?.['expires_at'] as number | undefined,
          source: 'file',
        };
      }
      case 'google':
        return {
          access_token: (raw['access_token'] as string) ?? '',
          refresh_token: raw['refresh_token'] as string | undefined,
          expires_at: raw['expiry_date'] as number | undefined,
          source: 'file',
        };
      default:
        return { access_token: (raw['access_token'] as string) ?? '', source: 'file' };
    }
  }

  private async refreshToken(
    provider: string, cred: ProviderCredential,
  ): Promise<ProviderCredential | null> {
    const endpoint = TOKEN_ENDPOINTS[provider];
    if (!endpoint || !cred.refresh_token) return null;

    const body: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: cred.refresh_token,
    };

    if (provider === 'openai') {
      body['client_id'] = OPENAI_CLIENT_ID;
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body),
      });

      if (!res.ok) return null;

      const data = await res.json() as Record<string, unknown>;
      return {
        ...cred,
        access_token: data['access_token'] as string,
        expires_at: Date.now() + ((data['expires_in'] as number) ?? 3600) * 1000,
      };
    } catch {
      return null;
    }
  }

  private writeBackCredential(
    provider: string, path: string, cred: ProviderCredential,
  ): void {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;

    switch (provider) {
      case 'openai': {
        const tokens = raw['tokens'] as Record<string, unknown>;
        tokens['access_token'] = cred.access_token;
        if (cred.expires_at) tokens['expires_at'] = cred.expires_at;
        raw['last_refresh'] = new Date().toISOString();
        break;
      }
      case 'google':
        raw['access_token'] = cred.access_token;
        if (cred.expires_at) raw['expiry_date'] = cred.expires_at;
        break;
    }

    writeFileSync(path, JSON.stringify(raw, null, 2), { mode: 0o600 });
  }

  private isExpired(cred: ProviderCredential): boolean {
    if (!cred.expires_at) return false;
    return cred.expires_at < Date.now() - 60_000;
  }
}
