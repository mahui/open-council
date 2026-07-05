import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveResourceRoot, resolveDefaultsDir } from '../../src/shared/resources.js';

/**
 * These tests reproduce the two on-disk layouts Open Council actually runs in
 * (dev source tree vs. flat tsup `dist/`) inside temp dirs, and assert the
 * walk-up resolver lands on the package root in both — the regression behind
 * task #34, where a fixed `../..` escaped the package in built/installed mode.
 */

let root: string;

/** Materialize a package root: package.json (name open-council) + defaults/. */
function makePackageRoot(dir: string): void {
  mkdirSync(join(dir, 'defaults', 'roles'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'open-council' }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oc-resources-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveResourceRoot', () => {
  it('resolves the package root from a deep dev source layout (src/<module>)', () => {
    // dev/tsx: repo root ships defaults/, module runs from src/config.
    makePackageRoot(root);
    const srcConfig = join(root, 'src', 'config');
    mkdirSync(srcConfig, { recursive: true });

    expect(resolveResourceRoot(srcConfig)).toBe(root);
  });

  it('resolves the package root from a flat built dist layout (dist/chunk)', () => {
    // built: every code-split handler is a chunk directly in dist/, one level
    // below the package root — the layout the old fixed `../..` broke.
    makePackageRoot(root);
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });

    expect(resolveResourceRoot(dist)).toBe(root);
  });

  it('resolves from an npm-install layout (node_modules/open-council/dist)', () => {
    const pkg = join(root, 'node_modules', 'open-council');
    makePackageRoot(pkg);
    const dist = join(pkg, 'dist');
    mkdirSync(dist, { recursive: true });

    expect(resolveResourceRoot(dist)).toBe(pkg);
  });

  it('skips a stray defaults/ dir whose package.json name does not match', () => {
    // An unrelated package with a defaults/ dir must not be mistaken for ours.
    const outer = join(root, 'other-pkg');
    mkdirSync(join(outer, 'defaults'), { recursive: true });
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'something-else' }));
    // The real package root sits above it.
    makePackageRoot(root);
    const dist = join(outer, 'dist');
    mkdirSync(dist, { recursive: true });

    expect(resolveResourceRoot(dist)).toBe(root);
  });

  it('falls back to the two-level dev anchor when no package root is found', () => {
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });

    expect(resolveResourceRoot(deep)).toBe(join(deep, '..', '..'));
  });
});

describe('resolveDefaultsDir', () => {
  it('returns <resource-root>/defaults', () => {
    makePackageRoot(root);
    const dist = join(root, 'dist');
    mkdirSync(dist, { recursive: true });

    expect(resolveDefaultsDir(dist)).toBe(join(root, 'defaults'));
  });
});
