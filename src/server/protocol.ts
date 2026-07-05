// src/server/protocol.ts — 线协议（server 私有契约）。纯类型，无运行时代码（ARCH-04）。
import type { DebatePhase, DegradationEvent, ConsensusResult, Session } from '../types/session.js';

/** SSE 事件类型枚举（与 Renderer 方法一一映射 + 生命周期）。 */
export type DebateEventType =
  | 'debate_start' // 服务端注入：流的第一个事件
  | 'phase' // Renderer.onPhaseStart
  | 'agent_start' // Renderer.onAgentStart
  | 'agent_progress' // Renderer.onAgentProgress（可丢弃）
  | 'agent_complete' // Renderer.onAgentComplete
  | 'consensus' // Renderer.onConsensus
  | 'degradation' // Renderer.onDegradation
  | 'result' // Renderer.renderResult —— 终态（成功）
  | 'error'; // 服务端注入 —— 终态（异常）

/**
 * 精简 Agent 传输对象。刻意不透传 Agent.config（ModelConfig）全量，
 * 只给渲染必需字段（SEC-02 payload 卫生）。
 * 注意：agentId 可能是编排哨兵值 '__review__' / '__synthesis__'，
 * 前端据此把评审/综合分别归入独立面板。
 */
export interface AgentDTO {
  agentId: string;
  role: string; // 形如 "🔬 研究员"
  roleDescription: string;
  modelName: string;
  isChairman: boolean;
  isDevilAdvocate: boolean;
}

/** 精简调用结果传输对象（省略 stderr 等诊断字段）。 */
export interface InvocationResultDTO {
  response: string;
  elapsedMs: number;
  invocationMode: 'cli' | 'api';
  timedOut: boolean;
  truncated?: boolean;
  tokenUsage?: { inputTokens: number; outputTokens: number };
}

// —— 各事件 payload —— //
export interface DebateStartPayload {
  debateId: string;
  question: string;
  mode: string;
}
export interface PhasePayload {
  phase: DebatePhase;
  index: number;
  total: number;
}
export interface AgentStartPayload {
  agent: AgentDTO;
}
export interface AgentProgressPayload {
  agentId: string;
  role: string;
  chunk: string;
}
export interface AgentCompletePayload {
  agent: AgentDTO;
  result: InvocationResultDTO;
}
export interface ConsensusPayload {
  consensus: ConsensusResult;
}
export interface DegradationPayload {
  event: DegradationEvent;
}
/** 终态成功：携带完整持久化 Session（含 session_id，供前端跳历史详情）。 */
export interface ResultPayload {
  session: Session;
}
/** 终态异常。 */
export interface ErrorPayload {
  message: string;
}

/** 判别联合，data 随 type 变化。 */
export type DebateEvent =
  | { type: 'debate_start'; data: DebateStartPayload }
  | { type: 'phase'; data: PhasePayload }
  | { type: 'agent_start'; data: AgentStartPayload }
  | { type: 'agent_progress'; data: AgentProgressPayload }
  | { type: 'agent_complete'; data: AgentCompletePayload }
  | { type: 'consensus'; data: ConsensusPayload }
  | { type: 'degradation'; data: DegradationPayload }
  | { type: 'result'; data: ResultPayload }
  | { type: 'error'; data: ErrorPayload };
