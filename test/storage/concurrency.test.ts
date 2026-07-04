import { describe, it, expect, afterEach, vi } from 'vitest';
import { isProcessAlive } from '../../src/storage/concurrency.js';

describe('isProcessAlive', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns true when process.kill succeeds (process reachable)', () => {
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    expect(isProcessAlive(1234)).toBe(true);
    expect(spy).toHaveBeenCalledWith(1234, 0);
  });

  it('returns true on EPERM (process exists but not signalable)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    expect(isProcessAlive(1)).toBe(true);
  });

  it('returns false on ESRCH (no such process)', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect(isProcessAlive(2147483647)).toBe(false);
  });

  it('reports the current process as alive (real call, no mock)', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });
});
