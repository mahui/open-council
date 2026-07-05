/**
 * Locate the package's bundled-resource root — the directory that ships
 * `defaults/` (roles, benchmark suite) and `web/` (the serve GUI) — working in
 * every layout Open Council runs under:
 *
 *  - dev/tsx:       source files live under `src/`; the resource root is the
 *                   repo root, a variable number of levels up from any module.
 *  - built (tsup):  every `await import()` command handler is code-split into
 *                   its own `dist/<name>-HASH.js` chunk sitting directly in
 *                   `dist/`, so a fixed `../..` from a chunk escapes the package
 *                   entirely. The resource root is `dist/`'s parent.
 *  - npm-installed: same as built (package root under node_modules/open-council).
 *
 * A fixed `import.meta.dirname + '../..'` cannot satisfy all three at once — the
 * dev source depth and the flat dist depth differ — which silently broke
 * default-asset resolution outside tsx. Instead we walk upward from the module
 * and pick the first ancestor that looks like the Open Council package root.
 *
 * Zero business dependencies, per the `src/shared/` contract.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let cachedRoot: string | undefined;

/**
 * True when `dir` is the Open Council package root: it ships a `defaults/`
 * directory AND a `package.json` whose name matches. Both checks matter — the
 * name guards against a stray `defaults/` dir on the way up, the `defaults/`
 * check against an unrelated package.json.
 */
function isPackageRoot(dir: string): boolean {
  if (!existsSync(join(dir, 'defaults'))) return false;
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: unknown };
    return pkg.name === 'open-council';
  } catch {
    return false;
  }
}

/**
 * Resolve the package resource root by walking up from `fromDir`. The result is
 * cached for the default anchor (module location); pass an explicit `fromDir`
 * — as tests do to simulate the dev/built layouts — to bypass the cache. Falls
 * back to the historical dev anchor (two levels up) when no root is found, so
 * downstream `existsSync` errors still point somewhere meaningful.
 */
export function resolveResourceRoot(fromDir: string = import.meta.dirname): string {
  const useCache = fromDir === import.meta.dirname;
  if (useCache && cachedRoot !== undefined) return cachedRoot;

  let dir = fromDir;
  for (;;) {
    if (isPackageRoot(dir)) {
      if (useCache) cachedRoot = dir;
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }

  const fallback = join(fromDir, '..', '..');
  if (useCache) cachedRoot = fallback;
  return fallback;
}

/** Absolute path to the bundled `defaults/` directory (roles, benchmark suite, …). */
export function resolveDefaultsDir(fromDir?: string): string {
  return join(resolveResourceRoot(fromDir), 'defaults');
}
