import { z } from 'zod';

export const ModelConfigSchema = z.object({
  name: z.string(),
  invocation: z.enum(['cli', 'api', 'auto']).default('auto'),
  provider: z.enum(['anthropic', 'openai', 'google', 'github-copilot', 'ollama', 'custom']).optional(),
  model: z.string().optional(),
  timeout_seconds: z.number().int().positive().default(120),
  capabilities: z.array(z.string()).default(['general']),
  priority: z.number().int().nonnegative().default(100),
  max_concurrent: z.number().int().positive().default(1),
  resource_weight: z.number().int().positive().default(1),
  enabled: z.boolean().default(true),

  // CLI-specific
  binary: z.string().optional(),
  model_args: z.array(z.string()).optional(),
  args: z.array(z.string()).optional(),
  input_mode: z.enum(['stdin', 'arg', 'file']).optional(),
  output_mode: z.enum(['stdout', 'file', 'json_field']).optional(),
  output_json_field: z.string().optional(),
  env: z.record(z.string()).optional(),
  health_check: z.object({
    command: z.array(z.string()),
    expect_exit_code: z.number().int().default(0),
    cache_seconds: z.number().int().default(300),
    timeout_seconds: z.number().int().default(10),
  }).optional(),

  // API-specific
  api_credential_path: z.string().optional(),
  api_base_url: z.string().url().optional(),
  api_key_env: z.string().optional(),
  streaming: z.boolean().default(true),
}).refine(
  (data) => {
    if (data.invocation === 'cli') {
      return !!data.binary && !!data.args && !!data.input_mode;
    }
    return true;
  },
  { message: 'CLI mode requires binary, args, and input_mode' },
);

export type ModelConfigFromSchema = z.infer<typeof ModelConfigSchema>;

export const CouncilConfigSchema = z.object({
  schema_version: z.number().int().default(1),

  general: z.object({
    default_mode: z.enum(['quick', 'compare', 'debate', 'auto']).default('auto'),
    default_chairman: z.string(),
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
      prefer: z.array(z.string()),
      chairman: z.string(),
      role_set: z.string().default('default'),
    }),
  }),

  concurrency: z.object({
    global_resource_limit: z.number().int().positive().default(10),
  }),

  circuit_breaker: z.object({
    failure_threshold: z.number().int().positive().default(5),
    recovery_seconds: z.number().int().positive().default(3600),
    enabled: z.boolean().default(true),
  }),

  output: z.object({
    format: z.enum(['markdown', 'json', 'plain']).default('markdown'),
    show_individual: z.boolean().default(false),
    show_scores: z.boolean().default(true),
    show_consensus: z.boolean().default(true),
    show_dimension_heatmap: z.boolean().default(true),
    show_timing: z.boolean().default(true),
    copy_to_clipboard: z.boolean().default(false),
    tui_mode: z.enum(['auto', 'always', 'never']).default('auto'),
  }),

  storage_security: z.object({
    session_retention_days: z.number().int().nonnegative().default(90),
  }),
});

export type CouncilConfigFromSchema = z.infer<typeof CouncilConfigSchema>;
