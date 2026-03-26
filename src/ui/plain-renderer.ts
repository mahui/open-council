import type { Agent, DebatePhase, DegradationEvent, ConsensusResult, Session } from '../types/session.js';
import type { InvocationResult } from '../types/provider.js';
import type { Renderer } from './renderer.js';
import { renderMarkdown } from './markdown.js';

const PHASE_LABELS: Record<string, string> = {
  route: 'Routing',
  broadcast: 'Collecting Perspectives',
  review: 'Peer Review',
  cross_examine: 'Cross-Examination',
  human_gate: 'Human Review',
  consensus: 'Computing Consensus',
  pre_synthesis_compression: 'Compressing',
  synthesis: 'Chairman Synthesizing',
};

const ROLE_ICONS: Record<string, string> = {
  analyst: '🔍',
  engineer: '⚙️',
  innovator: '💡',
  critic: '🎯',
  pragmatist: '📐',
  chairman: '👑',
};

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';

export class PlainRenderer implements Renderer {
  /** Are we in the synthesis phase (stream to stdout)? */
  private inSynthesis = false;
  private synthStreamed = false;
  private synthBuffer = '';
  private agentCount = 0;
  private completedCount = 0;

  onPhaseStart(phase: DebatePhase, index: number, total: number): void {
    const label = PHASE_LABELS[phase] ?? phase;

    if (phase === 'broadcast') {
      process.stderr.write(`\n${DIM}─── ${label} ───${RESET}\n\n`);
    } else if (phase === 'synthesis') {
      this.inSynthesis = true;
      process.stderr.write(`\n${DIM}─── ${label} ───${RESET}\n\n`);
    } else if (phase === 'route') {
      // silent
    } else {
      process.stderr.write(`\n${DIM}[${index + 1}/${total}] ${label}...${RESET}\n`);
    }
  }

  onAgentStart(agent: Agent): void {
    if (this.inSynthesis) return;
    this.agentCount++;
    process.stderr.write(`  ${DIM}${agent.role} [${agent.config.name}] thinking...${RESET}\n`);
  }

  onAgentProgress(agent: Agent, chunk: string): void {
    if (this.inSynthesis) {
      // Buffer synthesis for markdown rendering at completion
      this.synthBuffer += chunk;
      this.synthStreamed = true;
    }
    // During broadcast: don't stream individual agent output (they run in parallel, would interleave)
  }

  onAgentComplete(agent: Agent, result: InvocationResult): void {
    const time = (result.elapsed_ms / 1000).toFixed(1);
    const mode = result.invocation_mode === 'api' ? 'API' : 'CLI';
    const icon = ROLE_ICONS[agent.role] ?? '🤖';

    if (this.inSynthesis) {
      // Synthesis complete — render buffered markdown
      if (this.synthBuffer) {
        process.stdout.write(renderMarkdown(this.synthBuffer) + '\n');
      }
      process.stderr.write(`  ${GREEN}✓${RESET} ${DIM}Synthesis complete (${time}s)${RESET}\n`);
      return;
    }

    this.completedCount++;
    const preview = this.extractPreview(result.response, 120);
    process.stderr.write(
      `  ${GREEN}✓${RESET} ${BOLD}${agent.role}${RESET} ${DIM}[${agent.config.name}] ${time}s [${mode}]${RESET}\n` +
      `    ${CYAN}${preview}${RESET}\n\n`,
    );
  }

  onConsensus(result: ConsensusResult): void {
    const filled = Math.round(result.consensus_score * 20);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    const level = result.consensus_score >= 0.8 ? 'High'
                : result.consensus_score >= 0.5 ? 'Medium'
                : result.consensus_score >= 0.2 ? 'Low' : 'Very Low';
    process.stderr.write(
      `\n  Consensus: ${result.consensus_score.toFixed(2)} ${bar} (${level})\n`,
    );

    if (result.model_diversity_factor < 0.5) {
      process.stderr.write(
        `  ${YELLOW}⚠ Low model diversity (δ=${result.model_diversity_factor.toFixed(2)}), confidence reduced${RESET}\n`,
      );
    }
  }

  onDegradation(event: DegradationEvent): void {
    process.stderr.write(`  ${YELLOW}⚠ ${event.phase}: ${event.impact}${RESET}\n`);
  }

  renderResult(session: Session): void {
    // If we already streamed synthesis to stdout, don't repeat
    if (!this.synthStreamed) {
      const text = session.synthesis
        ?? session.stages.find(s => s.phase === 'broadcast')?.invocations
          .filter(i => !i.timed_out && i.response_raw)?.[0]?.response_raw;
      if (text) {
        process.stdout.write(renderMarkdown(text) + '\n');
      }
    }

    // Summary footer
    if (session.total_elapsed_ms) {
      const agents = session.agents.length;
      const succeeded = session.stages
        .flatMap(s => s.invocations)
        .filter(i => !i.timed_out && i.response_raw).length;
      process.stderr.write(
        `\n${DIM}─────────────────────────────${RESET}\n` +
        `  ${DIM}Total: ${(session.total_elapsed_ms / 1000).toFixed(1)}s | ` +
        `Mode: ${session.resolved_mode} | ` +
        `Agents: ${succeeded}/${agents}${RESET}\n`,
      );
    }
  }

  private extractPreview(text: string, maxLen: number): string {
    // Get first meaningful line as preview
    const lines = text.split('\n').filter(l => l.trim().length > 0);
    let preview = lines[0] ?? '';
    // Strip markdown headers
    preview = preview.replace(/^#+\s*/, '');
    if (preview.length > maxLen) {
      preview = preview.substring(0, maxLen) + '...';
    }
    return preview;
  }
}
