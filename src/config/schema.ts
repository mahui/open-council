import { z } from 'zod';

/**
 * Official line-protocol endpoints. Omitting `base_url` on a ModelConfig means
 * "use the official endpoint for the selected protocol".
 */
export const OFFICIAL_BASE_URL = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
} as const;

/**
 * ModelConfig v2 (standard-API convergence, schema_version 2).
 * A model is fully described by: which SDK (`protocol`), the wire `model` id,
 * an optional `base_url` (→ official endpoint when omitted), and an API key
 * sourced from an env var or a 0o600 key file. All CLI/OAuth fields are gone.
 */
export const ModelConfigSchema = z.object({
  name: z.string(),
  protocol: z.enum(['anthropic', 'openai']),  // selects the SDK client
  model: z.string(),                           // wire model id passed to the endpoint
  base_url: z.string().url().optional(),       // omitted → OFFICIAL_BASE_URL[protocol]

  api_key_env: z.string().optional(),
  api_key_path: z.string().optional(),
  provider: z.string().optional(),             // display / circuit-breaker key label (derived by default)

  reasoning_effort: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).optional(),
  temperature: z.number().optional(),
  max_tokens: z.number().int().positive().optional(),

  timeout_seconds: z.number().int().positive().default(120),
  capabilities: z.array(z.string()).default(['general']),
  priority: z.number().int().nonnegative().default(100),
  max_concurrent: z.number().int().positive().default(1),
  resource_weight: z.number().int().positive().default(1),
  enabled: z.boolean().default(true),
  streaming: z.boolean().default(true),

  legacy_disabled_reason: z.string().optional(),
});

export type ModelConfigFromSchema = z.infer<typeof ModelConfigSchema>;

export const CouncilConfigSchema = z.object({
  schema_version: z.number().int().default(2),

  general: z.object({
    default_mode: z.enum(['quick', 'compare', 'debate', 'auto']).default('auto'),
    default_chairman: z.string().default(''),
    // Model (by name) used to design the expert role panel. Empty → auto-pick a
    // balanced-tier model.
    role_generator_model: z.string().default(''),
    min_agents: z.number().int().min(1).default(2),
    max_agents: z.number().int().min(1).default(5),
    allow_same_model_agents: z.boolean().default(true),
    review_rounds: z.number().int().min(1).max(3).default(1),
    language: z.enum(['auto', 'zh', 'en']).default('auto'),
    compression_threshold_ratio: z.number().min(0).max(1).default(0.6),
    devil_advocate: z.enum(['auto', 'always', 'never']).default('auto'),
    high_risk_keywords: z.array(z.string()).default([]),
  }),

  storage: z.object({
    data_dir: z.string().default('~/.council/data'),
    checkpoint_dir: z.string().default('~/.council/checkpoints'),
    log_dir: z.string().default('~/.council/logs'),
    log_retention_days: z.number().int().default(7),
    orphan_checkpoint_hours: z.number().int().default(24),
  }),

  routing: z.object({
    strategy: z.enum(['keyword', 'llm', 'manual']).default('keyword'),
    dynamic_weight: z.boolean().default(true),
    dynamic_weight_alpha: z.number().min(0).max(1).default(0.3),
    dynamic_weight_shadow: z.boolean().default(true),
    exploration_rate: z.number().min(0).max(1).default(0.1),
    rules: z.array(z.unknown()).default([]),
    default: z.object({
      prefer: z.array(z.string()).default([]),
      chairman: z.string().default(''),
      role_set: z.string().default('default'),
    }),
  }),

  // Top-level .default({}) lets a partial config (or a wizard-assembled
  // minimal object) omit whole sections and still parse to full defaults.
  concurrency: z.object({
    global_resource_limit: z.number().int().positive().default(10),
  }).default({}),

  circuit_breaker: z.object({
    failure_threshold: z.number().int().positive().default(5),
    recovery_seconds: z.number().int().positive().default(3600),
    enabled: z.boolean().default(true),
  }).default({}),

  output: z.object({
    format: z.enum(['markdown', 'json', 'plain']).default('markdown'),
    show_individual: z.boolean().default(false),
    show_scores: z.boolean().default(true),
    show_consensus: z.boolean().default(true),
    show_dimension_heatmap: z.boolean().default(true),
    show_timing: z.boolean().default(true),
    copy_to_clipboard: z.boolean().default(false),
    tui_mode: z.enum(['auto', 'always', 'never']).default('auto'),
  }).default({}),

  storage_security: z.object({
    session_retention_days: z.number().int().nonnegative().default(90),
  }).default({}),
});

export type CouncilConfigFromSchema = z.infer<typeof CouncilConfigSchema>;
