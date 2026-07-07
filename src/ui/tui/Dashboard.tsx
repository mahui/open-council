/**
 * TUI Dashboard component — ink-based real-time debate visualiser.
 * Implements the Renderer interface visually via reactive state updates.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import type { ConsensusResult, DegradationEvent } from '../../types/session.js';
import type { InvocationMode } from '../../types/provider.js';

export interface AgentState {
  agent_id: string;
  role: string;
  model_name: string;
  invocation_mode: InvocationMode;
  status: 'waiting' | 'running' | 'done' | 'failed';
  elapsed_ms?: number;
}

export interface TuiState {
  question: string;
  mode: string;
  phase: string;
  phaseIndex: number;
  phaseTotal: number;
  agents: AgentState[];
  consensus?: ConsensusResult;
  degradations: DegradationEvent[];
  startedAt: number;
  done: boolean;
}

interface DashboardProps {
  getState: () => TuiState;
  onQuit: () => void;
}

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

function progressBar(ratio: number, width = 24): string {
  const filled = Math.round(ratio * width);
  return '\u2588'.repeat(filled) + '\u2591'.repeat(width - filled);
}

function formatElapsed(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s % 60).toFixed(0)}s`;
}

function agentStatusIcon(status: AgentState['status']): string {
  switch (status) {
    case 'done': return '\u2713';
    case 'running': return '\u25B6';
    case 'failed': return '\u2717';
    default: return '\u25CB';
  }
}

function agentStatusColor(status: AgentState['status']): string {
  switch (status) {
    case 'done': return 'green';
    case 'running': return 'cyan';
    case 'failed': return 'red';
    default: return 'gray';
  }
}

function agentStatusText(status: AgentState['status'], elapsedMs: number | undefined): string {
  switch (status) {
    case 'done': return elapsedMs !== undefined ? formatElapsed(elapsedMs) : 'done';
    case 'running': return 'running...';
    case 'failed': return 'failed';
    default: return 'waiting';
  }
}

function consensusLabel(score: number): string {
  if (score >= 0.8) return 'High';
  if (score >= 0.5) return 'Medium';
  return 'Low';
}

function consensusColor(score: number): string {
  if (score >= 0.7) return 'green';
  if (score >= 0.4) return 'yellow';
  return 'red';
}

export function Dashboard({ getState, onQuit }: DashboardProps): React.ReactElement {
  const [_tick, setTick] = useState(0);
  const { exit } = useApp();

  // Refresh every 200ms for elapsed-time updates
  useEffect(() => {
    const timer = setInterval(() => setTick(t => t + 1), 200);
    return (): void => { clearInterval(timer); };
  }, []);

  useInput((input, key) => {
    if (input === 'q' || key.escape) {
      onQuit();
      exit();
    }
  });

  const state = getState();
  const now = Date.now();
  const elapsed = formatElapsed(now - state.startedAt);
  const phaseLabel = PHASE_LABELS[state.phase] ?? state.phase;
  const phaseRatio = state.phaseTotal > 0 ? (state.phaseIndex + 1) / state.phaseTotal : 0;
  const questionPreview = state.question.length > 60
    ? state.question.substring(0, 57) + '...'
    : state.question;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      {/* Header */}
      <Box borderStyle="round" borderColor="cyan" flexDirection="column" paddingX={1}>
        <Box>
          <Text bold color="cyan">Open Council</Text>
          <Text dimColor>  {state.mode} mode  |  {elapsed}</Text>
        </Box>
        <Text dimColor>Q: {questionPreview}</Text>
      </Box>

      {/* Phase progress */}
      <Box flexDirection="column" paddingX={2} marginTop={0}>
        <Box>
          <Text bold>Phase [{state.phaseIndex + 1}/{state.phaseTotal}]: </Text>
          <Text color="cyan">{phaseLabel}</Text>
        </Box>
        <Text dimColor>{progressBar(phaseRatio)} {Math.round(phaseRatio * 100)}%</Text>
      </Box>

      {/* Agents */}
      {state.agents.length > 0 && (
        <Box flexDirection="column" marginTop={1} paddingX={2}>
          <Text bold>Agents</Text>
          {state.agents.map(a => (
            <Box key={a.agent_id}>
              <Text color={agentStatusColor(a.status)}>{agentStatusIcon(a.status)}  </Text>
              <Text>{a.model_name.padEnd(22)}</Text>
              <Text dimColor>{a.role.padEnd(16)}</Text>
              <Text dimColor>{a.invocation_mode.toUpperCase().padEnd(6)}</Text>
              <Text dimColor>{agentStatusText(a.status, a.elapsed_ms)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Consensus */}
      {state.consensus && (
        <Box flexDirection="column" marginTop={1} paddingX={2}>
          <Box>
            <Text bold>Consensus: </Text>
            <Text color={consensusColor(state.consensus.consensus_score)}>
              {state.consensus.consensus_score.toFixed(2)}
            </Text>
            <Text dimColor>  {progressBar(state.consensus.consensus_score)}  </Text>
            <Text dimColor>{consensusLabel(state.consensus.consensus_score)}</Text>
          </Box>
        </Box>
      )}

      {/* Degradation warnings */}
      {state.degradations.length > 0 && (
        <Box flexDirection="column" paddingX={2}>
          {state.degradations.slice(-2).map((d, i) => (
            <Text key={`deg-${d.phase}-${i}`} color="yellow">!  {d.phase}: {d.impact}</Text>
          ))}
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1} paddingX={2}>
        <Text dimColor>[q] quit</Text>
      </Box>
    </Box>
  );
}
