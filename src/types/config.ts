/**
 * ModelConfig, CouncilConfig type definitions.
 * Pure types — no runtime code (ARCH-04).
 * Actual zod schemas are in src/config/schema.ts.
 * NOTE: These must stay in sync with the zod schemas.
 */

export type Protocol = 'anthropic' | 'openai';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ModelConfig {
  name: string;
  protocol: Protocol;   // selects the SDK client (anthropic | openai)
  model: string;        // wire model id passed to the endpoint
  base_url?: string;    // omitted → official endpoint for the protocol

  api_key_env?: string;
  api_key_path?: string;
  provider?: string;    // display / circuit-breaker key label (derived by default)

  // Reasoning & generation params
  reasoning_effort?: ReasoningEffort;
  temperature?: number;
  max_tokens?: number;

  timeout_seconds: number;
  capabilities: string[];
  priority: number;
  max_concurrent: number;
  resource_weight: number;
  enabled: boolean;
  streaming: boolean;

  // Set by the schema_version 1→2 migration when a legacy model could not be
  // auto-converted; the model stays visible but disabled with this reason.
  legacy_disabled_reason?: string;
}

export interface CouncilConfig {
  schema_version: number;

  general: {
    default_mode: 'quick' | 'compare' | 'debate' | 'auto';
    default_chairman: string;
    role_generator_model?: string;
    min_agents: number;
    max_agents: number;
    allow_same_model_agents: boolean;
    review_rounds: number;
    language: 'auto' | 'zh' | 'en';
    compression_threshold_ratio: number;
    devil_advocate: 'auto' | 'always' | 'never';
    high_risk_keywords: string[];
  };

  storage: {
    data_dir: string;
    checkpoint_dir: string;
    log_dir: string;
    log_retention_days: number;
    orphan_checkpoint_hours: number;
  };

  routing: {
    strategy: 'keyword' | 'llm' | 'manual';
    dynamic_weight: boolean;
    dynamic_weight_alpha: number;
    dynamic_weight_shadow: boolean;
    exploration_rate: number;
    rules: unknown[];
    default: {
      prefer: string[];
      chairman: string;
      role_set: string;
    };
  };

  concurrency: {
    global_resource_limit: number;
  };

  circuit_breaker: {
    failure_threshold: number;
    recovery_seconds: number;
    enabled: boolean;
  };

  output: {
    format: 'markdown' | 'json' | 'plain';
    show_individual: boolean;
    show_scores: boolean;
    show_consensus: boolean;
    show_dimension_heatmap: boolean;
    show_timing: boolean;
    copy_to_clipboard: boolean;
    tui_mode: 'auto' | 'always' | 'never';
  };

  storage_security: {
    session_retention_days: number;
  };
}

export interface RoleDefinition {
  description: string;
  system_prompt: string;
  assign_to: string[];
}

export interface RoleSet {
  version: string;
  roles: Record<string, RoleDefinition>;
}
