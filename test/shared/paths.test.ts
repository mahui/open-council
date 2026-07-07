import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isResolvableModelName } from '../../src/shared/paths.js';

/**
 * `isResolvableModelName` (co-located with its only dependency `safePath`).
 * Answers "would safePath accept `<name>.yaml` inside the models dir?" so the
 * model commands / setup wizard can emit a friendly one-liner + exit 1 for a
 * traversal name instead of an uncaught safePath stack trace. safePath itself
 * remains the security backstop; here we pin the UX pre-check.
 */
const modelsDir = join(tmpdir(), 'council-name-guard', 'models');

describe('isResolvableModelName', () => {
  it('accepts ordinary model names', () => {
    expect(isResolvableModelName(modelsDir, 'gpt-4o')).toBe(true);
    expect(isResolvableModelName(modelsDir, 'claude-opus-4-20250514')).toBe(true);
  });

  it('accepts custom-endpoint names that legitimately contain colons', () => {
    expect(isResolvableModelName(modelsDir, 'custom:acme:llama3.2')).toBe(true);
  });

  it('rejects path-traversal names that would escape the models dir', () => {
    expect(isResolvableModelName(modelsDir, '../../evil')).toBe(false);
    expect(isResolvableModelName(modelsDir, '../evil')).toBe(false);
    expect(isResolvableModelName(modelsDir, '../../../etc/passwd')).toBe(false);
  });

  it('rejects an absolute path masquerading as a name', () => {
    expect(isResolvableModelName(modelsDir, '/etc/passwd')).toBe(false);
  });

  it('agrees with safePath on a plain (non-escaping) subpath — accepted, just not found later', () => {
    // `a/b.yaml` stays inside the models dir, so the guard passes; the mutation
    // then reports it as not-found rather than a traversal error.
    expect(isResolvableModelName(modelsDir, 'a/b')).toBe(true);
  });
});
