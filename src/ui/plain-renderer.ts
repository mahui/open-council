import type { Agent, DebatePhase, DegradationEvent, ConsensusResult, Session } from '../types/session.js';
import type { InvocationResult } from '../types/provider.js';
import type { Renderer } from './renderer.js';

const PHASE_LABELS: Record<string, string> = {
  route: 'Routing',
  broadcast: 'Broadcasting',
  review: 'Peer Review',
  human_gate: 'Human Review',
  consensus: 'Computing Consensus',
  pre_synthesis_compression: 'Compressing',
  synthesis: 'Synthesizing',
};

export class PlainRenderer implements Renderer {
  onPhaseStart(phase: DebatePhase, index: number, total: number): void {
    const label = PHASE_LABELS[phase] ?? phase;
    process.stderr.write(`[${index + 1}/${total}] ${label}...\n`);
  }

  onAgentStart(agent: Agent): void {
    process.stderr.write(`  ⏳ ${agent.config.name} (${agent.role})...\n`);
  }

  onAgentProgress(_agent: Agent, _chunk: string): void {
    // Phase 5: streaming progress
  }

  onAgentComplete(agent: Agent, result: InvocationResult): void {
    const mode = result.invocation_mode === 'api' ? 'API' : 'CLI';
    const time = (result.elapsed_ms / 1000).toFixed(1);
    process.stderr.write(
      `  ✓ ${agent.config.name} (${agent.role}) ${time}s [${mode}]\n`,
    );
  }

  onConsensus(result: ConsensusResult): void {
    const filled = Math.round(result.consensus_score * 20);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    const level = result.consensus_score >= 0.8 ? 'High'
                : result.consensus_score >= 0.5 ? 'Medium'
                : result.consensus_score >= 0.2 ? 'Low' : 'Very Low';
    process.stderr.write(
      `  Consensus: ${result.consensus_score.toFixed(2)} ${bar} (${level})\n`,
    );

    if (result.model_diversity_factor < 0.5) {
      process.stderr.write(
        `  ⚠ Low model diversity (δ=${result.model_diversity_factor.toFixed(2)}), confidence reduced\n`,
      );
    }
  }

  onDegradation(event: DegradationEvent): void {
    process.stderr.write(`  [!] ${event.phase}: ${event.impact}\n`);
  }

  renderResult(session: Session): void {
    if (session.synthesis) {
      process.stdout.write(session.synthesis + '\n');
    } else {
      // No synthesis — output best individual response
      const broadcastStage = session.stages.find(s => s.phase === 'broadcast');
      const best = broadcastStage?.invocations
        .filter(i => !i.timed_out && i.response_raw)?.[0];
      if (best) {
        process.stdout.write(best.response_raw + '\n');
      }
    }

    // Timing summary
    if (session.total_elapsed_ms) {
      process.stderr.write(
        `\n  Total: ${(session.total_elapsed_ms / 1000).toFixed(1)}s | ` +
        `Mode: ${session.resolved_mode} | ` +
        `Agents: ${session.agents.length}\n`,
      );
    }
  }
}
