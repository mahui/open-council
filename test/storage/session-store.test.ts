import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../../src/storage/session-store.js';
import type { Session } from '../../src/types/session.js';

const testDir = join(tmpdir(), 'council-sessions-test-' + Date.now());

function makeSession(id: string): Session {
  return {
    session_id: id,
    question: 'Test question',
    question_hash: 'abc123',
    mode: 'compare',
    resolved_mode: 'compare',
    status: 'completed',
    agents: [],
    stages: [],
    synthesis: 'Test synthesis',
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    total_elapsed_ms: 5000,
  };
}

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('SessionStore', () => {
  it('should save and retrieve a session', async () => {
    const store = new SessionStore(testDir);
    const session = makeSession('test-1');

    await store.saveSession(session);
    const loaded = await store.getSession('test-1');

    expect(loaded).not.toBeNull();
    expect(loaded!.session_id).toBe('test-1');
    expect(loaded!.synthesis).toBe('Test synthesis');
  });

  it('should return null for non-existent session', async () => {
    const store = new SessionStore(testDir);
    const loaded = await store.getSession('nonexistent');
    expect(loaded).toBeNull();
  });

  it('should list all sessions', async () => {
    const store = new SessionStore(testDir);

    await store.saveSession(makeSession('session-a'));
    await store.saveSession(makeSession('session-b'));
    await store.saveSession(makeSession('session-c'));

    const list = await store.listSessions();
    expect(list).toHaveLength(3);
  });

  it('should respect limit in listSessions', async () => {
    const store = new SessionStore(testDir);

    for (let i = 0; i < 5; i++) {
      await store.saveSession(makeSession(`session-${i}`));
    }

    const list = await store.listSessions({ limit: 2 });
    expect(list).toHaveLength(2);
  });

  it('should delete a session', async () => {
    const store = new SessionStore(testDir);
    await store.saveSession(makeSession('to-delete'));

    await store.deleteSession('to-delete');
    const loaded = await store.getSession('to-delete');
    expect(loaded).toBeNull();
  });
});
