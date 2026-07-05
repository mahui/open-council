/**
 * WebRenderer — the sole core接入点 for the Web GUI (ARCH-05).
 *
 * Implements `types/renderer.ts`'s `Renderer`; each of the 7 callbacks is
 * translated into a `DebateEvent` pushed onto the debate's `EventLog`, which
 * fans out to SSE subscribers. Agent / InvocationResult → DTO mapping happens
 * here so the wire payload stays minimal (SEC-02 payload hygiene): the full
 * `ModelConfig` never leaves the server process.
 */

import type { Renderer } from '../types/renderer.js';
import type { Agent, DebatePhase, DegradationEvent, ConsensusResult, Session } from '../types/session.js';
import type { InvocationResult } from '../types/provider.js';
import type { EventLog } from './event-log.js';
import type { AgentDTO, InvocationResultDTO } from './protocol.js';

export class WebRenderer implements Renderer {
  constructor(private readonly log: EventLog) {}

  onPhaseStart(phase: DebatePhase, index: number, total: number): void {
    this.log.push({ type: 'phase', data: { phase, index, total } });
  }

  onAgentStart(agent: Agent): void {
    this.log.push({ type: 'agent_start', data: { agent: toAgentDTO(agent) } });
  }

  onAgentProgress(agent: Agent, chunk: string): void {
    this.log.push({
      type: 'agent_progress',
      data: { agentId: agent.agent_id, role: agent.role, chunk },
    });
  }

  onAgentComplete(agent: Agent, result: InvocationResult): void {
    this.log.push({
      type: 'agent_complete',
      data: { agent: toAgentDTO(agent), result: toResultDTO(result) },
    });
  }

  onConsensus(result: ConsensusResult): void {
    this.log.push({ type: 'consensus', data: { consensus: result } });
  }

  onDegradation(event: DegradationEvent): void {
    this.log.push({ type: 'degradation', data: { event } });
  }

  renderResult(session: Session): void {
    this.log.push({ type: 'result', data: { session } });
  }
}

/** Project an Agent onto the minimal wire DTO (no ModelConfig leakage). */
export function toAgentDTO(agent: Agent): AgentDTO {
  return {
    agentId: agent.agent_id,
    role: agent.role,
    roleDescription: agent.role_description,
    modelName: agent.config.name,
    isChairman: agent.is_chairman,
    isDevilAdvocate: agent.is_devil_advocate,
  };
}

/** Project an InvocationResult onto the minimal wire DTO (drops stderr/diagnostics). */
export function toResultDTO(result: InvocationResult): InvocationResultDTO {
  const dto: InvocationResultDTO = {
    response: result.response,
    elapsedMs: result.elapsed_ms,
    invocationMode: result.invocation_mode,
    timedOut: result.timed_out,
  };
  if (result.truncated !== undefined) dto.truncated = result.truncated;
  if (result.token_usage) {
    dto.tokenUsage = {
      inputTokens: result.token_usage.input_tokens,
      outputTokens: result.token_usage.output_tokens,
    };
  }
  return dto;
}
