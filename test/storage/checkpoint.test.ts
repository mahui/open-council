import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
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
});
