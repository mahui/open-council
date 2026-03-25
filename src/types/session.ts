/**
 * Session, Stage, Invocation, Agent type definitions.
 * Pure types — no runtime code (ARCH-04).
 */

import type { ModelConfig } from './config.js';
import type { InvocationResult } from './provider.js';

export type DebateMode = 'quick' | 'compare' | 'debate' | 'auto';

export type DebatePhase =
  | 'route'
  | 'broadcast'
  | 'review'
  | 'human_gate'
  | 'consensus'
  | 'pre_synthesis_compression'
  | 'synthesis'
  | 'completed'
  | 'failed';

export type SessionStatus =
  | 'routing'
  | 'broadcasting'
  | 'reviewing'
  | 'human_gate'
  | 'computing_consensus'
  | 'compressing'
  | 'synthesizing'
  | 'completed'
  | 'failed';

export interface Agent {
  agent_id: string;
  config: ModelConfig;
  role: string;
  role_description: string;
  system_prompt: string;
  is_chairman: boolean;
  is_devil_advocate: boolean;
}

export interface Invocation {
  agent_id: string;
  model_name: string;
  role: string;
  prompt: string;
  response_raw: string;
  result: InvocationResult;
  timed_out: boolean;
}

export interface Stage {
  phase: DebatePhase;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  invocations: Invocation[];
  started_at?: string;
  completed_at?: string;
}

export interface DegradationEvent {
  phase: DebatePhase;
  reason: string;
  impact: string;
}

export interface ConsensusResult {
  consensus_score: number;
  dimension_scores: Record<string, { score: number; divergence: number }>;
  model_diversity_factor: number;
  raw_agreement: number;
}

export interface Session {
  session_id: string;
  question: string;
  question_hash: string;
  mode: DebateMode;
  resolved_mode: DebateMode;
  status: SessionStatus;
  agents: Agent[];
  stages: Stage[];
  synthesis?: string;
  consensus?: ConsensusResult;
  degradation_events?: DegradationEvent[];
  parent_session_id?: string;
  parent_synthesis?: string;
  tags?: string[];
  user_rating?: number;
  created_at: string;
  completed_at?: string;
  total_elapsed_ms?: number;
}

export interface RunOptions {
  mode: DebateMode;
  chairman?: string;
  models?: string[];
  interactive?: boolean;
  noStore?: boolean;
  resume?: boolean;
  sessionId?: string;
  tags?: string[];
  devilAdvocate?: boolean;
  roleSet?: string;
  parentSessionId?: string;
}
