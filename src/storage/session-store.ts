import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { initDatabase, closeDatabase } from './database.js';
import { PATHS } from '../config/paths.js';
import type { Session } from '../types/session.js';
import { safePath } from '../providers/utils.js';

export interface SessionFilter {
  status?: string;
  mode?: string;
  limit?: number;
  offset?: number;
}

export class SessionStore {
  private db: Database.Database;

  constructor(private sessionsDir: string) {
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(PATHS.dataDir, { recursive: true });
    this.db = initDatabase(PATHS.database);
  }

  async saveSession(session: Session): Promise<void> {
    const path = this.getPath(session.session_id);
    writeFileSync(path, JSON.stringify(session, null, 2), { mode: 0o600 });
    
    // Save to DB for FTS
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (
        session_id, question_hash, question_preview, synthesis_preview,
        mode, resolved_mode, status, consensus_score, models_used,
        created_at, completed_at, total_elapsed_ms, parent_session_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const modelsUsed = session.agents?.map(a => a.config.name).join(',') ?? '';
    
    stmt.run(
      session.session_id,
      session.question_hash,
      session.question.substring(0, 500),
      session.synthesis ? session.synthesis.substring(0, 500) : null,
      session.mode,
      session.resolved_mode,
      session.status,
      session.consensus?.consensus_score ?? null,
      modelsUsed,
      session.created_at,
      session.completed_at ?? null,
      session.total_elapsed_ms ?? null,
      session.parent_session_id ?? null
    );
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

    let query = 'SELECT session_id FROM sessions WHERE 1=1';
    const params: any[] = [];
    
    if (filter?.status) {
      query += ' AND status = ?';
      params.push(filter.status);
    }
    if (filter?.mode) {
      query += ' AND mode = ?';
      params.push(filter.mode);
    }
    
    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(filter?.limit ?? 50, filter?.offset ?? 0);
    
    const rows = this.db.prepare(query).all(...params) as { session_id: string }[];
    
    const sessions: Session[] = [];
    for (const row of rows) {
      const s = await this.getSession(row.session_id);
      if (s) sessions.push(s);
    }
    return sessions;
  }
  
  async searchSimilar(query: string, limit = 3): Promise<Session[]> {
    // Simple FTS match on question
    // We replace characters that might break FTS MATCH syntax
    const safeQuery = query.replace(/["']/g, ' ').trim();
    if (!safeQuery) return [];
    
    const stmt = this.db.prepare(`
      SELECT session_id
      FROM sessions_fts
      WHERE sessions_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);
    
    try {
      // FTS prefix search on words
      const matchExpr = safeQuery.split(/\s+/).filter(w => w.length > 2).map(w => `"${w}"*`).join(' OR ');
      if (!matchExpr) return [];
      
      const rows = stmt.all(matchExpr, limit) as { session_id: string }[];
      
      const sessions: Session[] = [];
      for (const row of rows) {
        const s = await this.getSession(row.session_id);
        if (s) sessions.push(s);
      }
      return sessions;
    } catch (err) {
      return [];
    }
  }

  async deleteSession(id: string): Promise<void> {
    const path = this.getPath(id);
    if (existsSync(path)) {
      unlinkSync(path);
    }
    this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(id);
  }

  close(): void {
    closeDatabase(this.db);
  }

  private getPath(sessionId: string): string {
    return safePath(this.sessionsDir, `${sessionId}.json`);
  }
}
