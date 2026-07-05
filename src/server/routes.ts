/**
 * REST + SSE routes (design §5). Thin transport layer: validate → delegate to
 * DebateManager / SessionStore, project to minimal wire shapes. No business
 * logic (that lives in core / storage).
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { SSEStreamingApi } from 'hono/streaming';
import { z } from 'zod';
import type { DebateMode, Session } from '../types/session.js';
import type { SessionStore } from '../storage/session-store.js';
import type { ConfigLoader } from '../config/loader.js';
import type { CredentialManager } from '../providers/credentials/discovery.js';
import type { DebateManager } from './debate-manager.js';
import type { EventLog } from './event-log.js';
import type { DebateEvent } from './protocol.js';
import type { RuntimeConfig } from './runtime-config.js';
import { createConfigRoutes } from './config-routes.js';

const MODES: DebateMode[] = ['quick', 'compare', 'debate', 'auto'];
const HEARTBEAT_MS = 15_000;

export interface RouteDeps {
  manager: DebateManager;
  store: SessionStore;
  /** Live config holder — /api/models and the config routes read its snapshot. */
  runtime: RuntimeConfig;
  /** Config persistence for the settings routes. */
  loader: ConfigLoader;
  /** Boot credential set (rescan replaces it). */
  credentialManager: CredentialManager;
}

const StartDebateSchema = z.object({
  // Upper bound keeps a runaway paste from flowing verbatim into every
  // agent prompt (cost guard); generous enough for any real question.
  question: z.string().min(1).max(8_000),
  mode: z.enum(['quick', 'compare', 'debate', 'auto']).optional(),
  models: z.array(z.string()).optional(),
  chairman: z.string().optional(),
  devilAdvocate: z.boolean().optional(),
  roleSet: z.string().optional(),
});

/** Build the `/api` router (mounted by app.ts). */
export function createApiRoutes(deps: RouteDeps): Hono {
  const api = new Hono();

  // POST /api/debates — start a debate, return { debateId } (202).
  api.post('/debates', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = StartDebateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request', details: parsed.error.flatten() }, 400);
    }
    const debateId = deps.manager.startDebate({
      question: parsed.data.question,
      mode: parsed.data.mode ?? 'auto',
      models: parsed.data.models,
      chairman: parsed.data.chairman,
      devilAdvocate: parsed.data.devilAdvocate,
      roleSet: parsed.data.roleSet,
    });
    return c.json({ debateId }, 202);
  });

  // GET /api/debates/:debateId/events — SSE live stream.
  api.get('/debates/:debateId/events', (c) => {
    const debateId = c.req.param('debateId');
    const log = deps.manager.getLog(debateId);
    if (!log || log.isEvicted) {
      return c.json({ error: 'debate not found or expired' }, 404);
    }
    const lastEventId = parseLastEventId(c.req.header('last-event-id'));
    return streamSSE(c, (stream) => pumpEvents(stream, log, lastEventId));
  });

  // GET /api/sessions — history list (projected summaries).
  api.get('/sessions', async (c) => {
    const limit = parseIntParam(c.req.query('limit'));
    const offset = parseIntParam(c.req.query('offset'));
    const mode = c.req.query('mode');
    const sessions = await deps.store.listSessions({
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
      ...(mode ? { mode } : {}),
    });
    return c.json({ sessions: sessions.map(toSummary) });
  });

  // GET /api/sessions/:id — history detail.
  api.get('/sessions/:id', async (c) => {
    const session = await deps.store.getSession(c.req.param('id'));
    if (!session) return c.json({ error: 'session not found' }, 404);
    return c.json({ session });
  });

  // GET /api/models — model metadata + mode enum for the form (no credentials).
  api.get('/models', (c) => {
    const snapshot = deps.runtime.current;
    return c.json({
      models: snapshot.models.map((m) => ({
        name: m.name,
        provider: m.provider,
        capabilities: m.capabilities,
        invocation: m.invocation,
      })),
      modes: MODES,
      defaultChairman: snapshot.defaultChairman,
    });
  });

  // Settings面 routes (design-notes/web-gui-config.md §4): GET/PUT /config,
  // PATCH /models/:name, POST /providers/custom, POST /setup/rescan.
  api.route('/', createConfigRoutes({
    runtime: deps.runtime,
    loader: deps.loader,
    credentialManager: deps.credentialManager,
  }));

  return api;
}

/** SSE pump: replay buffered events > lastEventId, then follow live until terminal. */
async function pumpEvents(
  stream: SSEStreamingApi,
  log: EventLog,
  lastEventId: number | null,
): Promise<void> {
  const queue: Array<{ id: number; event: DebateEvent }> = [];
  let terminated = false;
  let wake: (() => void) | null = null;

  const enqueue = (event: DebateEvent, id: number): void => {
    queue.push({ id, event });
    if (event.type === 'result' || event.type === 'error') terminated = true;
    wake?.();
  };

  // Replay then subscribe in the same synchronous tick (no push can interleave).
  log.replayFrom(lastEventId, enqueue);
  const unsubscribe = log.subscribe(enqueue);
  stream.onAbort(() => wake?.());

  try {
    while (!stream.aborted) {
      if (queue.length > 0) {
        const next = queue.shift();
        if (!next) continue;
        await stream.writeSSE({
          id: String(next.id),
          event: next.event.type,
          data: JSON.stringify(next.event.data),
        });
        if (next.event.type === 'result' || next.event.type === 'error') break;
        continue;
      }
      if (terminated) break;
      const got = await waitForEvent((fn) => {
        wake = fn;
      });
      wake = null;
      if (!got && !stream.aborted && queue.length === 0 && !terminated) {
        await stream.write(':hb\n\n'); // heartbeat comment — no event id consumed
      }
    }
  } finally {
    unsubscribe();
  }
}

/** Resolve true when woken by an event, false on heartbeat timeout. */
function waitForEvent(register: (fn: () => void) => void): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, HEARTBEAT_MS);
    timer.unref?.();
    register(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}

interface SessionSummary {
  session_id: string;
  question: string;
  resolved_mode: DebateMode;
  status: string;
  consensus_score?: number;
  created_at: string;
  user_rating?: number;
}

/** Projection to keep the list response small (design §5). */
function toSummary(s: Session): SessionSummary {
  const summary: SessionSummary = {
    session_id: s.session_id,
    question: s.question.length > 140 ? `${s.question.slice(0, 140)}…` : s.question,
    resolved_mode: s.resolved_mode,
    status: s.status,
    created_at: s.created_at,
  };
  if (s.consensus?.consensus_score !== undefined) summary.consensus_score = s.consensus.consensus_score;
  if (s.user_rating !== undefined) summary.user_rating = s.user_rating;
  return summary;
}

function parseLastEventId(header: string | undefined): number | null {
  if (!header) return null;
  const n = Number.parseInt(header, 10);
  return Number.isFinite(n) ? n : null;
}

function parseIntParam(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}
