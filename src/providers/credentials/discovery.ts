import { readFileSync, existsSync, writeFileSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ModelConfig, Protocol } from '../../types/config.js';
import type { DiscoveryReport } from '../../types/provider.js';
import { PATHS } from '../../config/paths.js';

const DEBUG = !!process.env['COUNCIL_DEBUG'];
function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[credentials] ${msg}\n`);
}

/**
 * The env var that, by convention, holds the API key for each official protocol
 * endpoint. Used as the last-resort fallback in {@link CredentialManager.getApiKey}
 * and as the sole targets of {@link CredentialManager.discoverAll}.
 */
const DEFAULT_ENV_BY_PROTOCOL: Record<Protocol, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

const CUSTOM_KEY_PREFIX = 'custom-';
const CUSTOM_KEY_SUFFIX = '.key';

/**
 * Credential resolution collapsed to the standard-API model (design-notes/
 * standard-api-convergence.md §2.2): an API key comes from an env var or a
 * 0o600 key file — no OAuth login, token refresh, keychain read, or CLI
 * subprocess. The manager only ever *reads* local credentials (plus
 * {@link saveCustomKey} for GUI-entered custom-endpoint keys); it never copies
 * key material into logs, DTOs, or config YAML (SEC-02).
 */
export class CredentialManager {
  /**
   * Resolve a usable API key for a model, or `null` when none is configured
   * (e.g. a localhost no-auth endpoint like Ollama — the caller decides whether
   * an empty key is acceptable).
   *
   * Resolution order:
   *   1. `api_key_env`  → the named environment variable
   *   2. `api_key_path` → a 0o600 key file
   *   3. the protocol's default env var (ANTHROPIC_API_KEY / OPENAI_API_KEY)
   */
  getApiKey(config: ModelConfig): string | null {
    // 1. Explicit env var reference.
    if (config.api_key_env) {
      const v = process.env[config.api_key_env];
      if (v && v.length > 0) return v;
    }

    // 2. 0o600 key file.
    if (config.api_key_path && existsSync(config.api_key_path)) {
      try {
        const key = readFileSync(config.api_key_path, 'utf-8').trim();
        if (key.length > 0) return key;
      } catch (err) {
        // ASYNC-04: never swallow silently — a bad key file should be traceable.
        debug(`failed to read api_key_path '${config.api_key_path}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. Protocol default env var.
    const defaultEnv = DEFAULT_ENV_BY_PROTOCOL[config.protocol];
    const dv = process.env[defaultEnv];
    if (dv && dv.length > 0) return dv;

    return null;
  }

  /**
   * Report which credentials are visible on this machine — the two official env
   * vars plus any custom key files already saved under `~/.council/credentials`.
   * Consumed by the setup wizard and `/setup/rescan` to render credential status;
   * the returned report only carries presence + source, never key material.
   */
  discoverAll(): DiscoveryReport {
    const report: DiscoveryReport = {};

    // Official protocol env vars.
    for (const [protocol, envVar] of Object.entries(DEFAULT_ENV_BY_PROTOCOL)) {
      const v = process.env[envVar];
      if (v && v.length > 0) {
        report[protocol] = { source: 'env', status: 'valid', env_var: envVar };
      }
    }

    // Custom-endpoint key files (custom-<name>.key).
    try {
      if (existsSync(PATHS.credentials)) {
        for (const file of readdirSync(PATHS.credentials)) {
          if (file.startsWith(CUSTOM_KEY_PREFIX) && file.endsWith(CUSTOM_KEY_SUFFIX)) {
            const name = file.slice(CUSTOM_KEY_PREFIX.length, -CUSTOM_KEY_SUFFIX.length);
            report[`custom:${name}`] = {
              source: 'file',
              status: 'valid',
              path: join(PATHS.credentials, file),
            };
          }
        }
      }
    } catch (err) {
      // ASYNC-04: directory scan failure is non-fatal but should be traceable.
      debug(`failed to scan credentials dir '${PATHS.credentials}': ${err instanceof Error ? err.message : String(err)}`);
    }

    return report;
  }

  /**
   * Persist a user-supplied API key for a custom endpoint to a 0o600 file and
   * return its path (SEC-03: file perms 0o600; SEC-02: key never logged). `name`
   * must already be sanitized by the caller. The path scheme matches the
   * custom-endpoint key store read back at invoke time.
   */
  saveCustomKey(name: string, key: string): string {
    mkdirSync(PATHS.credentials, { recursive: true, mode: 0o700 });
    const path = join(PATHS.credentials, `${CUSTOM_KEY_PREFIX}${name}${CUSTOM_KEY_SUFFIX}`);
    writeFileSync(path, key, { mode: 0o600 });
    chmodSync(path, 0o600);
    return path;
  }
}
