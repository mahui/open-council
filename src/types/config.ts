/**
 * ModelConfig, CouncilConfig type definitions.
 * Pure types — no runtime code (ARCH-04).
 * Actual zod schemas are in src/config/schema.ts (Phase 1).
 * For Phase 0, these are hand-defined minimal types.
 */

export type InvocationMode = 'cli' | 'api' | 'auto';

export type ProviderName = 'anthropic' | 'openai' | 'google' | 'github-copilot' | 'ollama' | 'custom';

export interface ModelConfig {
  name: string;
  invocation: InvocationMode;
  provider?: ProviderName;
  model?: string;
  timeout_seconds: number;
  capabilities: string[];
  priority: number;
  max_concurrent: number;
  resource_weight: number;
  enabled: boolean;

  // CLI-specific
  binary?: string;
  model_args?: string[];
  args?: string[];
  input_mode?: 'stdin' | 'arg' | 'file';
  output_mode?: 'stdout' | 'file' | 'json_field';
  output_json_field?: string;
  env?: Record<string, string>;
  health_check?: {
    command: string[];
    expect_exit_code: number;
    cache_seconds: number;
    timeout_seconds: number;
  };

  // API-specific
  api_credential_path?: string;
  api_base_url?: string;
  api_key_env?: string;
  streaming: boolean;
}

export interface CouncilConfig {
  schema_version: number;

  general: {
    default_mode: 'quick' | 'compare' | 'debate' | 'auto';
    default_chairman: string;
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
