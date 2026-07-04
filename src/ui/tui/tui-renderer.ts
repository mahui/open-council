/**
 * TUI Renderer — ink-based real-time dashboard that implements Renderer interface.
 * Replaces PlainRenderer when stderr is a TTY and tui_mode is not 'never'.
 */

import React from 'react';
import { render } from 'ink';
import type { Agent, DebatePhase, DegradationEvent, ConsensusResult, Session } from '../../types/session.js';
import type { InvocationResult } from '../../types/provider.js';
import type { Renderer } from '../../types/renderer.js';
import { renderMarkdown } from '../markdown.js';
import { Dashboard } from './Dashboard.js';
import type { TuiState, AgentState } from './Dashboard.js';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export class TuiRenderer implements Renderer {
  private state: TuiState;
  private tuiRerender: ((element: React.ReactElement) => void) | null = null;
  private tuiUnmount: (() => void) | null = null;
  private unmounted = false;
  private synthBuffer = '';
  private synthStreamed = false;

  constructor(question: string, mode: string) {
    this.state = {
      question,
      mode,
      phase: 'route',
      phaseIndex: 0,
      phaseTotal: 5,
      agents: [],
      consensus: undefined,
      degradations: [],
      startedAt: Date.now(),
      done: false,
    };
    this.startTui();
  }

  private startTui(): void {
    const getState = (): TuiState => this.state;
    const onQuit = (): void => { this.cleanup(); };

    try {
      const instance = render(
        React.createElement(Dashboard, { getState, onQuit }),
        { exitOnCtrlC: false },
      );
      this.tuiRerender = instance.rerender;
      this.tuiUnmount = instance.unmount;
    } catch {
      // If ink fails (non-TTY fallback, etc), degrade silently
      this.unmounted = true;
    }
  }

  private refresh(): void {
    if (this.unmounted || !this.tuiRerender) return;
    const getState = (): TuiState => this.state;
    const onQuit = (): void => { this.cleanup(); };
    this.tuiRerender(React.createElement(Dashboard, { getState, onQuit }));
  }

  private cleanup(): void {
    if (!this.unmounted) {
      this.unmounted = true;
      this.tuiUnmount?.();
    }
  }

  onPhaseStart(phase: DebatePhase, index: number, total: number): void {
    // Before synthesis: update TUI. During synthesis: unmount to let stdout stream.
    if (phase === 'synthesis') {
      this.cleanup();
      process.stderr.write(`\n${DIM}--- Chairman Synthesizing ---${RESET}\n\n`);
      return;
    }
    this.state.phase = phase;
    this.state.phaseIndex = index;
    this.state.phaseTotal = total;
    this.refresh();
  }

  onAgentStart(agent: Agent): void {
    if (this.unmounted) {
      process.stderr.write(`  ${agent.role} [${agent.config.name}] thinking...\n`);
      return;
    }
    const existing = this.state.agents.find(
      (a: AgentState) => a.agent_id === agent.agent_id,
    );
    if (existing) {
      existing.status = 'running';
    } else {
      this.state.agents.push({
        agent_id: agent.agent_id,
        role: agent.role,
        model_name: agent.config.name,
        invocation_mode: agent.config.invocation === 'cli' ? 'cli' : 'api',
        status: 'running',
      });
    }
    this.refresh();
  }

  onAgentProgress(_agent: Agent, chunk: string): void {
    if (this.unmounted) {
      // Synthesis is streaming to stdout
      this.synthBuffer += chunk;
      this.synthStreamed = true;
    }
    // During broadcast/review: don't stream (agents run in parallel)
  }

  onAgentComplete(agent: Agent, result: InvocationResult): void {
    if (this.unmounted) {
      // Synthesis complete -- render buffered markdown
      if (this.synthBuffer) {
        process.stdout.write(renderMarkdown(this.synthBuffer) + '\n');
        this.synthBuffer = '';
      }
      const time = (result.elapsed_ms / 1000).toFixed(1);
      process.stderr.write(`  \x1b[32m\u2713\x1b[0m ${DIM}Synthesis complete (${time}s)${RESET}\n`);
      return;
    }
    const agentState = this.state.agents.find(
      (a: AgentState) => a.agent_id === agent.agent_id,
    );
    if (agentState) {
      agentState.status = 'done';
      agentState.elapsed_ms = result.elapsed_ms;
    }
    this.refresh();
  }

  onConsensus(result: ConsensusResult): void {
    this.state.consensus = result;
    this.refresh();
  }

  onDegradation(event: DegradationEvent): void {
    this.state.degradations.push(event);
    this.refresh();
  }

  renderResult(session: Session): void {
    // Ensure TUI is cleaned up before writing to stdout
    this.cleanup();

    // Output synthesis if not already streamed
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
        `\n${DIM}-----------------------------${RESET}\n` +
        `  ${DIM}Total: ${(session.total_elapsed_ms / 1000).toFixed(1)}s | ` +
        `Mode: ${session.resolved_mode} | ` +
        `Agents: ${succeeded}/${agents}${RESET}\n`,
      );
    }
  }
}
