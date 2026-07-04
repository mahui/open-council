/**
 * Renderer interface — ui ↔ core bridge (ARCH-05).
 *
 * Lives in types/ (neutral home) so neither side of the bridge (core, ui)
 * has to reach across a layer boundary to reference it.
 */

import type { Agent, DebatePhase, DegradationEvent, ConsensusResult, Session } from './session.js';
import type { InvocationResult } from './provider.js';

export interface Renderer {
  onPhaseStart(phase: DebatePhase, index: number, total: number): void;
  onAgentStart(agent: Agent): void;
  onAgentProgress(agent: Agent, chunk: string): void;
  onAgentComplete(agent: Agent, result: InvocationResult): void;
  onConsensus(result: ConsensusResult): void;
  onDegradation(event: DegradationEvent): void;
  renderResult(session: Session): void;
}
