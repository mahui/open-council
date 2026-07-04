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
  | 'cross_examine'
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
  | 'cross_examining'
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
  /** Compressed version of response_raw (set during pre-synthesis compression). Original is preserved. */
  response_compressed?: string;
  result: InvocationResult;
  timed_out: boolean;
}

export interface Stage {
  phase: DebatePhase;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  invocations: Invocation[];
  started_at?: string;
  completed_at?: string;
  /** Anonymized label → agent_id mapping, set by the review stage to preserve shuffle order. */
  label_map?: Record<string, string>;
  /**
   * Per-reviewer anonymized mapping: reviewerAgentId → (local label → reviewed agent_id).
   * Set by the review stage under self-review exclusion (N ≥ 3), where each
   * reviewer sees a distinct anonymized subset (its own answer removed), so a
   * single `label_map` no longer suffices. Absent for the N = 2 full-set path.
   */
  reviewer_label_maps?: Record<string, Record<string, string>>;
}

export interface DegradationEvent {
  phase: DebatePhase;
  reason: string;
  impact: string;
}

export interface ConsensusResult {
  /**
   * Reviewer-to-reviewer agreement (0-1), independent of provider diversity.
   * ★ Stop criterion for the cross-examine loop ★ = rawAgreement × rho.
   */
  agreement_score: number;
  /**
   * Diversity-discounted external consensus score = agreement_score ×
   * model_diversity_factor. Used for display / query / DB. Semantics unchanged.
   */
  consensus_score: number;
  dimension_scores: Record<string, { score: number; divergence: number }>;
  /** Model diversity credibility factor δ (0-1), an independent reliability qualifier. */
  model_diversity_factor: number;
  /** @deprecated Alias of `agreement_score`, retained for reading old data. Always equals `agreement_score`. */
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
  /** Whether devil's advocate mode was requested for this session. */
  devil_advocate_mode?: boolean;
  /** Synthesis snippets from similar past sessions injected as broadcast background context. */
  historical_context?: string;
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
  /** Synthesis snippets from similar past sessions, injected as broadcast context. */
  historicalContext?: string;
  /** Synthesis text from the parent session (loaded when --follow is used). */
  parentSynthesis?: string;
}
