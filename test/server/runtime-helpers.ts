/**
 * Shared test helpers for building server deps after the RuntimeConfig refactor
 * (design-notes/web-gui-config.md §5). DebateManager and createApp now read the
 * live snapshot from a RuntimeConfig instead of holding value fields.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeConfig } from '../../src/server/runtime-config.js';
import { ConfigLoader } from '../../src/config/loader.js';
import { CredentialManager } from '../../src/providers/credentials/discovery.js';
import type { InvocationAdapter } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';

/** Build a RuntimeConfig snapshot from a mock adapter + model set (all enabled). */
export function makeRuntime(
  adapter: InvocationAdapter,
  models: ModelConfig[],
  defaultChairman = 'claude',
): RuntimeConfig {
  return new RuntimeConfig({ adapter, models, allModels: models, defaultChairman });
}

/** Throwaway config/credential deps for routes that never touch the settings面. */
export function makeConfigDeps(): { loader: ConfigLoader; credentialManager: CredentialManager } {
  const dir = mkdtempSync(join(tmpdir(), 'oc-server-test-'));
  return { loader: new ConfigLoader(dir), credentialManager: new CredentialManager() };
}
