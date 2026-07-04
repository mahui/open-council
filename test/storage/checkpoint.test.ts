import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CheckpointManager } from '../../src/storage/checkpoint.js';
import type { Session } from '../../src/types/session.js';

const testDir = join(tmpdir(), 'council-ckpt-test-' + Date.now());

function makeSession(id: string): Session {
  return {
    session_id: id,
    question: 'Test',
    question_hash: 'hash',
    mode: 'compare',
    resolved_mode: 'compare',
    status: 'broadcasting',
    agents: [],
    stages: [],
    created_at: new Date().toISOString(),
  };
}

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('CheckpointManager', () => {
  it('should save and restore a checkpoint', () => {
    const mgr = new CheckpointManager(testDir);
    const session = makeSession('ckpt-1');

    mgr.save(session);
    const restored = mgr.restore('ckpt-1');

    expect(restored).not.toBeNull();
    expect(restored!.session_id).toBe('ckpt-1');
    expect(restored!.status).toBe('broadcasting');
  });

  it('should return null for non-existent checkpoint', () => {
    const mgr = new CheckpointManager(testDir);
    expect(mgr.restore('nonexistent')).toBeNull();
  });

  it('should remove a checkpoint', () => {
    const mgr = new CheckpointManager(testDir);
    mgr.save(makeSession('to-remove'));

    mgr.remove('to-remove');
    expect(mgr.restore('to-remove')).toBeNull();
  });

  it('should find most recent checkpoint when no ID specified', () => {
    const mgr = new CheckpointManager(testDir);
    mgr.save(makeSession('old-session'));

    // Small delay to ensure different mtime
    const newer = makeSession('new-session');
    mgr.save(newer);

    const restored = mgr.restore();
    expect(restored).not.toBeNull();
    // Should get one of the saved sessions
    expect(['old-session', 'new-session']).toContain(restored!.session_id);
  });

  it('should restore a checkpoint whose originating process is dead', () => {
    // Crash recovery: the originating PID is necessarily gone. Write a checkpoint
    // file directly with a PID that cannot be alive and an in-progress status.
    const deadPid = 2147483647; // implausibly high, guaranteed not running
    const session = makeSession('crashed-session');
    const ckpt = {
      ...session,
      pid: deadPid,
      last_updated_at: new Date().toISOString(),
    };
    writeFileSync(join(testDir, 'crashed-session.ckpt.json'), JSON.stringify(ckpt, null, 2), { mode: 0o600 });

    const mgr = new CheckpointManager(testDir);

    // Both targeted and scan-based restore must surface the dead-PID checkpoint.
    expect(mgr.restore('crashed-session')?.session_id).toBe('crashed-session');
    expect(mgr.restore()?.session_id).toBe('crashed-session');
  });

  it('should purge completed checkpoints on restore scan', () => {
    const done = { ...makeSession('done-session'), status: 'completed' as const,
      pid: process.pid, last_updated_at: new Date().toISOString() };
    writeFileSync(join(testDir, 'done-session.ckpt.json'), JSON.stringify(done, null, 2), { mode: 0o600 });

    const mgr = new CheckpointManager(testDir);
    // Scan-based restore triggers cleanup of completed checkpoints.
    expect(mgr.restore()).toBeNull();
    expect(mgr.restore('done-session')).toBeNull();
  });

  it('should purge checkpoints older than the retention window', () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const stale = { ...makeSession('stale-session'), pid: 2147483647, last_updated_at: eightDaysAgo };
    writeFileSync(join(testDir, 'stale-session.ckpt.json'), JSON.stringify(stale, null, 2), { mode: 0o600 });

    const mgr = new CheckpointManager(testDir);
    expect(mgr.restore()).toBeNull();
  });

  it('should not corrupt an existing checkpoint when a stray temp file is present', () => {
    const mgr = new CheckpointManager(testDir);
    mgr.save(makeSession('atomic-session'));

    // Simulate an interrupted write: a truncated temp file left behind in the dir.
    writeFileSync(join(testDir, 'atomic-session.ckpt.json.deadbeef.tmp'), '{ "session_id": "atomic-sess');

    // The primary checkpoint must remain intact and loadable; temp files ignored.
    const restored = mgr.restore('atomic-session');
    expect(restored?.session_id).toBe('atomic-session');
    expect(restored?.status).toBe('broadcasting');

    // Scan-based restore must not be confused by the .tmp file either.
    expect(mgr.restore()?.session_id).toBe('atomic-session');
  });

  it('should write checkpoints with 0o600 permissions', () => {
    const mgr = new CheckpointManager(testDir);
    mgr.save(makeSession('perm-session'));

    const mode = statSync(join(testDir, 'perm-session.ckpt.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('should not leave temp files behind after a successful save', () => {
    const mgr = new CheckpointManager(testDir);
    mgr.save(makeSession('clean-session'));

    const leftovers = readdirSync(testDir).filter(f => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);

    // Sanity: the committed file is valid JSON.
    const raw = readFileSync(join(testDir, 'clean-session.ckpt.json'), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
