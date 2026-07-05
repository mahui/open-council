import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validatePort, browserOpenCommand, resolveWebRoot } from '../../src/commands/serve.js';

describe('serve: validatePort', () => {
  it('defaults to 3720 when unset', () => {
    expect(validatePort(undefined)).toBe(3720);
  });

  it('accepts a valid in-range port', () => {
    expect(validatePort('8080')).toBe(8080);
    expect(validatePort('1')).toBe(1);
    expect(validatePort('65535')).toBe(65535);
  });

  it('rejects out-of-range ports', () => {
    expect(validatePort('0')).toBeNull();
    expect(validatePort('65536')).toBeNull();
    expect(validatePort('-1')).toBeNull();
  });

  it('rejects non-numeric input', () => {
    expect(validatePort('abc')).toBeNull();
    expect(validatePort('')).toBeNull();
  });
});

describe('serve: browserOpenCommand', () => {
  it('maps each platform to its opener', () => {
    expect(browserOpenCommand('darwin')).toBe('open');
    expect(browserOpenCommand('win32')).toBe('start');
    expect(browserOpenCommand('linux')).toBe('xdg-open');
    expect(browserOpenCommand('freebsd')).toBe('xdg-open');
  });
});

describe('serve: resolveWebRoot', () => {
  it('resolves the real web/ (with index.html) from the src/commands layout', () => {
    // Default anchor is serve.ts at src/commands → repo-root/web must exist.
    const root = resolveWebRoot();
    expect(existsSync(join(root, 'index.html'))).toBe(true);
  });

  it('resolves the package-root web/ from the built dist layout (one level up)', () => {
    // Simulate dist/serve-*.js: package root is one level up, so <repo>/web.
    const distDir = join(process.cwd(), 'dist');
    const root = resolveWebRoot(distDir);
    expect(root).toBe(join(process.cwd(), 'web'));
    expect(existsSync(join(root, 'index.html'))).toBe(true);
  });
});
