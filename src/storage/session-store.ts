import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Session } from '../types/session.js';

export interface SessionFilter {
  status?: string;
  mode?: string;
  limit?: number;
  offset?: number;
}

export class SessionStore {
  constructor(private sessionsDir: string) {
    mkdirSync(this.sessionsDir, { recursive: true });
  }

  async saveSession(session: Session): Promise<void> {
    const path = this.getPath(session.session_id);
    writeFileSync(path, JSON.stringify(session, null, 2), { mode: 0o600 });
  }

  async getSession(id: string): Promise<Session | null> {
    const path = this.getPath(id);
    if (!existsSync(path)) return null;

    try {
      return JSON.parse(readFileSync(path, 'utf-8')) as Session;
    } catch {
      return null;
    }
  }

  async listSessions(filter?: SessionFilter): Promise<Session[]> {
    if (!existsSync(this.sessionsDir)) return [];

    const files = readdirSync(this.sessionsDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();

    const sessions: Session[] = [];
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;

    let count = 0;
    for (const file of files) {
      try {
        const session = JSON.parse(
          readFileSync(join(this.sessionsDir, file), 'utf-8'),
        ) as Session;

        if (filter?.status && session.status !== filter.status) continue;
        if (filter?.mode && session.mode !== filter.mode) continue;

        count++;
        if (count <= offset) continue;
        if (sessions.length >= limit) break;

        sessions.push(session);
      } catch {
        // Skip corrupt files
      }
    }

    return sessions;
  }

  async deleteSession(id: string): Promise<void> {
    const path = this.getPath(id);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  private getPath(sessionId: string): string {
    return join(this.sessionsDir, `${sessionId}.json`);
  }
}
