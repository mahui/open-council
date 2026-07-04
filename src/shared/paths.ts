/**
 * Cross-layer, domain-agnostic path utilities.
 *
 * `src/shared/` holds only zero-dependency, business-neutral helpers.
 * It MUST NOT import any business module (core, providers, storage, config,
 * ui, commands) — doing so would turn shared into a junk drawer and
 * reintroduce the reverse-dependency edges this layer exists to remove.
 */

import { resolve } from 'node:path';

/**
 * Validate that a resolved file path stays within the expected parent directory.
 * Prevents path traversal attacks via names containing "../". (SEC-critical, pure.)
 */
export function safePath(parentDir: string, filename: string): string {
  const resolved = resolve(parentDir, filename);
  const resolvedParent = resolve(parentDir);
  if (!resolved.startsWith(resolvedParent + '/') && resolved !== resolvedParent) {
    throw new Error(`Path traversal detected: ${filename} resolves outside ${parentDir}`);
  }
  return resolved;
}
