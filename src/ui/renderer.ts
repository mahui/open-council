/**
 * Renderer interface — ui ↔ core bridge (ARCH-05).
 */

import type { Agent, DebatePhase, DegradationEvent, ConsensusResult, Session } from '../types/session.js';
import type { InvocationResult } from '../types/provider.js';

export interface Renderer {
  onPhaseStart(phase: DebatePhase, index: number, total: number): void;
  onAgentStart(agent: Agent): void;
  onAgentProgress(agent: Agent, chunk: string): void;
  onAgentComplete(agent: Agent, result: InvocationResult): void;
  onConsensus(result: ConsensusResult): void;
  onDegradation(event: DegradationEvent): void;
  renderResult(session: Session): void;
}
