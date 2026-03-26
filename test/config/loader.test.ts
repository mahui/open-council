import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigLoader } from '../../src/config/loader.js';

const testDir = join(tmpdir(), 'council-test-' + Date.now());

beforeEach(() => {
  mkdirSync(join(testDir, 'models'), { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('ConfigLoader', () => {
  it('should detect unconfigured state', () => {
    const loader = new ConfigLoader(testDir);
    expect(loader.isConfigured()).toBe(false);
  });

  it('should throw ConfigNotFoundError when no council.yaml', () => {
    const loader = new ConfigLoader(testDir);
    expect(() => loader.loadCouncilConfig()).toThrow('Configuration file not found');
  });

  it('should save and load council config', () => {
    const loader = new ConfigLoader(testDir);
    const config = {
      schema_version: 1,
      general: {
        default_mode: 'auto' as const,
        default_chairman: 'claude',
        min_agents: 2,
        max_agents: 5,
        allow_same_model_agents: true,
        review_rounds: 1,
        language: 'auto' as const,
        compression_threshold_ratio: 0.6,
        devil_advocate: 'auto' as const,
        high_risk_keywords: [],
      },
      storage: {
        data_dir: '~/.council/data',
        checkpoint_dir: '~/.council/checkpoints',
        log_dir: '~/.council/logs',
        log_retention_days: 7,
        orphan_checkpoint_hours: 24,
      },
      routing: {
        strategy: 'keyword' as const,
        dynamic_weight: true,
        dynamic_weight_alpha: 0.3,
        dynamic_weight_shadow: true,
        exploration_rate: 0.1,
        rules: [],
        default: { prefer: ['claude'], chairman: 'claude', role_set: 'default' },
      },
      concurrency: { global_resource_limit: 10 },
      circuit_breaker: { failure_threshold: 5, recovery_seconds: 3600, enabled: true },
      output: {
        format: 'markdown' as const,
        show_individual: false,
        show_scores: true,
        show_consensus: true,
        show_dimension_heatmap: true,
        show_timing: true,
        copy_to_clipboard: false,
        tui_mode: 'auto' as const,
      },
      storage_security: { session_retention_days: 90 },
    };

    loader.saveCouncilConfig(config);
    expect(loader.isConfigured()).toBe(true);

    const loaded = loader.loadCouncilConfig();
    expect(loaded.general.default_chairman).toBe('claude');
    expect(loaded.general.default_mode).toBe('auto');
  });

  it('should save and load model configs', () => {
    const loader = new ConfigLoader(testDir);

    const modelYaml = `
name: test-model
invocation: api
provider: anthropic
model: claude-sonnet-4-20250514
timeout_seconds: 120
capabilities: [general]
priority: 100
max_concurrent: 1
resource_weight: 1
enabled: true
streaming: true
`;
    writeFileSync(join(testDir, 'models', 'test-model.yaml'), modelYaml);

    const models = loader.loadAllModels();
    expect(models).toHaveLength(1);
    expect(models[0]!.name).toBe('test-model');
    expect(models[0]!.provider).toBe('anthropic');
  });

  it('should filter disabled models', () => {
    const loader = new ConfigLoader(testDir);

    writeFileSync(join(testDir, 'models', 'enabled.yaml'), `
name: enabled
invocation: api
provider: anthropic
model: test
timeout_seconds: 120
enabled: true
streaming: true
`);

    writeFileSync(join(testDir, 'models', 'disabled.yaml'), `
name: disabled
invocation: api
provider: openai
model: test
timeout_seconds: 120
enabled: false
streaming: true
`);

    const models = loader.loadAllModels();
    expect(models).toHaveLength(1);
    expect(models[0]!.name).toBe('enabled');
  });
});
