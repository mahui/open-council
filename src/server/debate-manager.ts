/**
 * DebateManager — concurrent debate routing + background orchestration.
 *
 * Holds `Map<debateId, EventLog>` so multiple debates can run and be observed
 * in parallel. The server生成 an独立 `debateId` (NOT the Orchestrator's internal
 * `session_id`, which does not exist until `run()` creates the session) as the
 * live-stream key, so the EventLog is registered before orchestration starts
 * and no early events are lost (design §3 决策 3).
 *
 * `startDebate()` returns synchronously (so the route can 202 immediately) and
 * runs the orchestration in the background; lifecycle terminates with a
 * `result` (success) or `error` (failure) event followed by `markTerminal()`.
 */

import { randomUUID } from 'node:crypto';
import type { RoleSet } from '../types/config.js';
import type { DebateMode, RunOptions } from '../types/session.js';
import { Orchestrator } from '../core/orchestrator.js';
import type { SessionStore } from '../storage/session-store.js';
import { EventLog } from './event-log.js';
import { WebRenderer } from './web-renderer.js';
import type { RuntimeConfig } from './runtime-config.js';

export interface DebateManagerDeps {
  /**
   * Live config holder — adapter / models / chairman / role-gen model are read
   * from its CURRENT snapshot at debate start (design §5), so config writes take
   * effect on the next debate without reconstructing the manager.
   */
  runtime: RuntimeConfig;
  /** Persistence store (shared, long-lived connection). */
  store: SessionStore;
  /** Resolve an explicit role-set template by name (for `roleSet` input). */
  loadRoleSet?: (name: string) => RoleSet;
  /** When true, debates are not persisted (MVP default: persist). */
  noStore?: boolean;
  /** Test seam: override EventLog options (byte budget / TTL). */
  eventLogOptions?: { maxBytes?: number; ttlMs?: number };
}

export interface StartDebateInput {
  question: string;
  mode: DebateMode;
  models?: string[];
  chairman?: string;
  devilAdvocate?: boolean;
  roleSet?: string;
}

export class DebateManager {
  private readonly logs = new Map<string, EventLog>();

  constructor(private readonly deps: DebateManagerDeps) {}

  /** Kick off a debate; returns its `debateId` immediately (orchestration runs in background). */
  startDebate(input: StartDebateInput): string {
    const debateId = randomUUID();
    const log = new EventLog({
      ...this.deps.eventLogOptions,
      onEvict: () => this.logs.delete(debateId),
    });
    this.logs.set(debateId, log);

    log.push({
      type: 'debate_start',
      data: { debateId, question: input.question, mode: input.mode },
    });

    void this.runDebate(log, input);
    return debateId;
  }

  getLog(debateId: string): EventLog | undefined {
    return this.logs.get(debateId);
  }

  /** Background orchestration: assemble → run → persist → emit terminal event. */
  private async runDebate(log: EventLog, input: StartDebateInput): Promise<void> {
    try {
      // Capture the current snapshot once per debate — an in-flight debate keeps
      // its models/adapter even if the config is rewritten mid-run (design §5).
      const snapshot = this.deps.runtime.current;
      const explicitRoleSet = this.resolveRoleSet(input.roleSet);
      const renderer = new WebRenderer(log);
      const orchestrator = new Orchestrator(
        snapshot.adapter,
        renderer,
        snapshot.models,
        input.chairman ?? snapshot.defaultChairman,
        undefined,
        snapshot.roleGenModel,
        explicitRoleSet,
      );

      const runOptions: RunOptions = {
        mode: input.mode,
        chairman: input.chairman,
        models: input.models,
        devilAdvocate: input.devilAdvocate,
        roleSet: input.roleSet,
        noStore: this.deps.noStore,
      };

      const session = await orchestrator.run(input.question, runOptions);

      if (!this.deps.noStore) {
        try {
          await this.deps.store.saveSession(session);
        } catch (err) {
          // Persistence failure must not abort the stream: the client still
          // gets the full session in the terminal `result` event.
          process.stderr.write(
            `Warning: failed to save session ${session.session_id}: ${errMessage(err)}\n`,
          );
        }
      }

      log.push({ type: 'result', data: { session } });
    } catch (err) {
      log.push({ type: 'error', data: { message: errMessage(err) } });
    } finally {
      log.markTerminal();
    }
  }

  private resolveRoleSet(name: string | undefined): RoleSet | undefined {
    if (!name) return undefined;
    if (!this.deps.loadRoleSet) {
      throw new Error(`role set "${name}" requested but no resolver is configured`);
    }
    return this.deps.loadRoleSet(name);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
