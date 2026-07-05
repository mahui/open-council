import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigLoader } from '../../src/config/loader.js';
import type { CouncilConfig } from '../../src/types/config.js';

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

  describe('role sets', () => {
    it('lists the built-in default role sets', () => {
      const loader = new ConfigLoader(testDir);
      const sets = loader.listRoleSets();
      // Built-in defaults/roles/*.yaml ship with the package.
      expect(sets).toContain('default');
      expect(sets).toContain('code-review');
      expect(sets).toContain('architecture');
    });

    it('merges and dedupes user-defined role sets with built-ins', () => {
      mkdirSync(join(testDir, 'roles'), { recursive: true });
      writeFileSync(join(testDir, 'roles', 'my-set.yaml'), 'version: "1.0.0"\nroles: {}\n');
      // A user file that shadows a built-in name must not appear twice.
      writeFileSync(join(testDir, 'roles', 'default.yaml'), 'version: "1.0.0"\nroles: {}\n');

      const loader = new ConfigLoader(testDir);
      const sets = loader.listRoleSets();
      expect(sets).toContain('my-set');
      expect(sets.filter(s => s === 'default')).toHaveLength(1);
      // Sorted output.
      expect([...sets]).toEqual([...sets].sort());
    });

    it('loads a built-in role set by name', () => {
      const loader = new ConfigLoader(testDir);
      const roleSet = loader.loadRoleSet('default');
      expect(Object.keys(roleSet.roles).length).toBeGreaterThan(0);
    });

    it('prefers a user-defined role set over a built-in of the same name', () => {
      mkdirSync(join(testDir, 'roles'), { recursive: true });
      writeFileSync(
        join(testDir, 'roles', 'default.yaml'),
        'version: "9.9.9"\nroles:\n  solo:\n    description: d\n    system_prompt: p\n    assign_to: []\n',
      );
      const loader = new ConfigLoader(testDir);
      const roleSet = loader.loadRoleSet('default');
      expect(roleSet.version).toBe('9.9.9');
      expect(Object.keys(roleSet.roles)).toEqual(['solo']);
    });

    it('throws RoleSetNotFoundError for an unknown role set', () => {
      const loader = new ConfigLoader(testDir);
      expect(() => loader.loadRoleSet('does-not-exist')).toThrow('Role set not found');
    });
  });

  describe('loadCouncilConfigSafe', () => {
    it('returns null when council.yaml does not exist', () => {
      const loader = new ConfigLoader(testDir);
      expect(loader.loadCouncilConfigSafe()).toBeNull();
    });

    it('returns the parsed config when council.yaml is valid', () => {
      const loader = new ConfigLoader(testDir);
      loader.saveCouncilConfig({
        schema_version: 1,
        general: {
          default_mode: 'auto',
          default_chairman: 'claude',
          role_generator_model: '',
          min_agents: 2,
          max_agents: 5,
          allow_same_model_agents: true,
          review_rounds: 1,
          language: 'auto',
          compression_threshold_ratio: 0.6,
          devil_advocate: 'auto',
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
          strategy: 'keyword',
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
          format: 'markdown',
          show_individual: false,
          show_scores: true,
          show_consensus: true,
          show_dimension_heatmap: true,
          show_timing: true,
          copy_to_clipboard: false,
          tui_mode: 'auto',
        },
        storage_security: { session_retention_days: 90 },
      });

      const safe = loader.loadCouncilConfigSafe();
      expect(safe?.general.default_chairman).toBe('claude');
    });

    it('renames a corrupt council.yaml to .bak and returns null, without throwing', () => {
      const path = join(testDir, 'council.yaml');
      writeFileSync(path, ': this is not : valid : yaml : [[[', 'utf-8');

      const loader = new ConfigLoader(testDir);
      const result = loader.loadCouncilConfigSafe();

      expect(result).toBeNull();
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}.bak`)).toBe(true);
      expect(readFileSync(`${path}.bak`, 'utf-8')).toContain('this is not');
    });

    it('renames a schema-invalid council.yaml (wrong type) to .bak and returns null', () => {
      const path = join(testDir, 'council.yaml');
      // Valid YAML, but violates the schema (min_agents must be >= 1).
      writeFileSync(path, 'general:\n  min_agents: -1\n', 'utf-8');

      const loader = new ConfigLoader(testDir);
      const result = loader.loadCouncilConfigSafe();

      expect(result).toBeNull();
      expect(existsSync(path)).toBe(false);
      expect(existsSync(`${path}.bak`)).toBe(true);
    });
  });

  describe('saveCouncilConfig', () => {
    it('throws on a schema-invalid config and does not write anything to disk', () => {
      const loader = new ConfigLoader(testDir);
      const path = join(testDir, 'council.yaml');

      const invalid = {
        schema_version: 1,
        general: {
          default_mode: 'not-a-real-mode', // invalid enum value
          default_chairman: 'claude',
          min_agents: 2,
          max_agents: 5,
          allow_same_model_agents: true,
          review_rounds: 1,
          language: 'auto',
          compression_threshold_ratio: 0.6,
          devil_advocate: 'auto',
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
          strategy: 'keyword',
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
          format: 'markdown',
          show_individual: false,
          show_scores: true,
          show_consensus: true,
          show_dimension_heatmap: true,
          show_timing: true,
          copy_to_clipboard: false,
          tui_mode: 'auto',
        },
        storage_security: { session_retention_days: 90 },
      };

      expect(() => loader.saveCouncilConfig(invalid as unknown as CouncilConfig)).toThrow();
      expect(existsSync(path)).toBe(false);
    });
  });
});
