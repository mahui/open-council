/**
 * Cross-layer, domain-agnostic runtime-environment probes.
 *
 * `src/shared/` holds only zero-dependency, business-neutral helpers.
 * It MUST NOT import any business module (core, providers, storage, config,
 * ui, commands) — doing so would turn shared into a junk drawer and
 * reintroduce the reverse-dependency edges this layer exists to remove.
 */

import { execFileSync } from 'node:child_process';

/**
 * Check if a binary exists on the system PATH.
 * Uses execFileSync (no shell) to avoid command injection via binary names.
 */
export function hasBinary(name: string): boolean {
  // Validate binary name to prevent path traversal or shell metacharacters
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) return false;
  try {
    execFileSync('which', [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
