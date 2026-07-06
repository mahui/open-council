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

// —— 配置读投影（脱敏，绝不含任何 secret）—— //
// 见 design-notes/web-gui-config.md §4.1。不变量：任何字段都不得来源于
// api_key_env 的值、api_credential_path 指向的文件内容、或 OAuth token。

export interface GeneralSettingsDTO {
  default_mode: 'quick' | 'compare' | 'debate' | 'auto';
  default_chairman: string;
  role_generator_model: string;
  min_agents: number;
  max_agents: number;
  devil_advocate: 'auto' | 'always' | 'never';
  language: 'auto' | 'zh' | 'en';
}

export interface ModelSettingDTO {
  name: string;
  provider?: string;
  invocation: 'cli' | 'api' | 'auto';
  capabilities: string[];
  enabled: boolean;
  isCustom: boolean; // provider 以 "custom:" 前缀
  apiBaseUrl?: string; // 仅自定义端点展示
  hasCredentialFile: boolean; // api_credential_path 是否存在 —— 绝不含 key
  version: string; // 该模型 yaml 字节的 sha256 —— PATCH 乐观锁令牌（§4.3，独立于 council.yaml）
}

/** 只读段：仅供展示现值，无写路径。 */
export interface ReadOnlyConfigDTO {
  schema_version: number;
  storage: { data_dir: string; checkpoint_dir: string; log_dir: string };
  routing: { strategy: string };
  concurrency: { global_resource_limit: number };
  circuit_breaker: { enabled: boolean; failure_threshold: number; recovery_seconds: number };
  storage_security: { session_retention_days: number };
}

export interface ConfigDTO {
  version: string; // 乐观锁令牌（council.yaml 内容 sha256）
  general: GeneralSettingsDTO;
  prefer: string[]; // routing.default.prefer
  models: ModelSettingDTO[]; // 含禁用模型
  readOnly: ReadOnlyConfigDTO;
  // 非阻断性提示（仅 PUT 写回时可能出现）：如 chairman 已知但被禁用，写入放行但附带说明。
  warning?: string;
}

export interface UpdateConfigRequest {
  general?: Partial<GeneralSettingsDTO>;
  prefer?: string[];
  version: string; // 必填：GET 拿到的令牌，用于乐观锁
}

/** rescan 结果摘要 —— 无任何 secret 出线。 */
export interface RescanSummaryDTO {
  credentials: Array<{
    provider: string;
    status: 'valid' | 'refreshed' | 'expired' | 'not_found' | 'parse_error';
    source: 'env' | 'file';
    // DiscoveryResult.path 被刻意剔除（泄露 home 目录结构，对 GUI 无价值）。
  }>;
  models: { added: string[]; existing: string[] }; // 名称
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
