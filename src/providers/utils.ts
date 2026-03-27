/**
 * Shared provider utilities.
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

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

/**
 * Validate that a resolved file path stays within the expected parent directory.
 * Prevents path traversal attacks via names containing "../".
 */
export function safePath(parentDir: string, filename: string): string {
  const resolved = resolve(parentDir, filename);
  const resolvedParent = resolve(parentDir);
  if (!resolved.startsWith(resolvedParent + '/') && resolved !== resolvedParent) {
    throw new Error(`Path traversal detected: ${filename} resolves outside ${parentDir}`);
  }
  return resolved;
}
