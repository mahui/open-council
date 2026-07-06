/**
 * Tests for the wizard's own pure helpers (src/ui/wizard/first-run.ts) after the
 * standard-API convergence: no OAuth login, no CLI binary probing. Naming /
 * chairman-selection / custom-endpoint shaping now live in
 * src/providers/model-assembly.ts and are covered by
 * test/providers/model-assembly.test.ts instead of here.
 */
import { describe, it, expect } from 'vitest';
import { isRecommended, clampAgents, credentialHint } from '../../../src/ui/wizard/first-run.js';
import { assembleConfig, dedupePrefer } from '../../../src/config/assemble-council.js';
import type { CouncilConfig } from '../../../src/types/config.js';
import type { DiscoveredModel } from '../../../src/providers/model-discovery.js';
import { PATHS } from '../../../src/config/paths.js';

function makeDiscovered(overrides: Partial<DiscoveredModel> & { id: string }): DiscoveredModel {
  return {
    name: overrides.id,
    protocol: 'anthropic',
    source: 'official',
    ...overrides,
  };
}

describe('isRecommended', () => {
  it.each<[string, Partial<DiscoveredModel>, boolean]>([
    ['Anthropic opus', { id: 'claude-opus-4-20250514' }, true],
    ['Anthropic sonnet-4', { id: 'claude-sonnet-4-20250514' }, true],
    ['Anthropic 3-5-sonnet', { id: 'claude-3-5-sonnet-20241022' }, true],
    ['OpenAI o3', { id: 'o3', protocol: 'openai' }, true],
    ['OpenAI o4', { id: 'o4', protocol: 'openai' }, true],
    ['OpenAI gpt-4o', { id: 'gpt-4o', protocol: 'openai' }, true],
    ['OpenAI gpt-5', { id: 'gpt-5', protocol: 'openai' }, true],
    ['OpenAI gpt-5-turbo (no mini suffix)', { id: 'gpt-5-turbo', protocol: 'openai' }, true],

    ['Anthropic haiku excluded', { id: 'claude-haiku-3-5' }, false],
    ['OpenAI gpt-4o-mini excluded (not exact gpt-4o)', { id: 'gpt-4o-mini', protocol: 'openai' }, false],
    ['OpenAI gpt-5-mini excluded', { id: 'gpt-5-mini', protocol: 'openai' }, false],
    ['OpenAI o1 not on the recommended list', { id: 'o1', protocol: 'openai' }, false],
    ['an unremarkable custom-endpoint id excluded', { id: 'llama-3-70b-instruct', protocol: 'openai', source: 'my-gateway' }, false],
  ])('%s', (_label, overrides, expected) => {
    expect(isRecommended(makeDiscovered(overrides))).toBe(expected);
  });
});

describe('clampAgents', () => {
  it('1 model available → { min: 1, max: 3 } (multi-role single-model scenario)', () => {
    expect(clampAgents(1)).toEqual({ min: 1, max: 3 });
  });

  it('2 models available → { min: 2, max: 2 }', () => {
    expect(clampAgents(2)).toEqual({ min: 2, max: 2 });
  });

  it('3 models available → { min: 2, max: 3 }', () => {
    expect(clampAgents(3)).toEqual({ min: 2, max: 3 });
  });

  it('5+ models available → max caps at 5', () => {
    expect(clampAgents(5)).toEqual({ min: 2, max: 5 });
    expect(clampAgents(10)).toEqual({ min: 2, max: 5 });
  });
});

describe('credentialHint', () => {
  it.each<[string, string]>([
    ['anthropic', 'set ANTHROPIC_API_KEY'],
    ['Anthropic', 'set ANTHROPIC_API_KEY'],
    ['claude-opus', 'set ANTHROPIC_API_KEY'],
    ['openai', 'set OPENAI_API_KEY'],
    ['gpt-4o', 'set OPENAI_API_KEY'],
    ['google', 'set the endpoint API key (env var or key file)'],
    ['github-copilot', 'set the endpoint API key (env var or key file)'],
    ['custom:my-gateway', 'set the endpoint API key (env var or key file)'],
    ['some-unknown-provider', 'set the endpoint API key (env var or key file)'],
  ])('provider=%s → matching hint', (provider, expected) => {
    expect(credentialHint(provider)).toContain(expected);
  });
});

describe('assembleConfig', () => {
  const customBase: CouncilConfig = {
    schema_version: 1,
    general: {
      default_mode: 'debate',
      default_chairman: 'old-chairman',
      role_generator_model: 'old-role-gen',
      min_agents: 3,
      max_agents: 4,
      allow_same_model_agents: false,
      review_rounds: 3,
      language: 'zh',
      compression_threshold_ratio: 0.42,
      devil_advocate: 'always',
      high_risk_keywords: ['launch', 'deploy'],
    },
    storage: {
      data_dir: '/custom/data',
      checkpoint_dir: '/custom/checkpoints',
      log_dir: '/custom/logs',
      log_retention_days: 30,
      orphan_checkpoint_hours: 48,
    },
    routing: {
      strategy: 'llm',
      dynamic_weight: false,
      dynamic_weight_alpha: 0.7,
      dynamic_weight_shadow: false,
      exploration_rate: 0.2,
      rules: [{ pattern: 'code', role_set: 'code-review' }],
      default: { prefer: ['old-model'], chairman: 'old-chairman', role_set: 'custom-set' },
    },
    concurrency: { global_resource_limit: 42 },
    circuit_breaker: { failure_threshold: 9, recovery_seconds: 1800, enabled: false },
    output: {
      format: 'json',
      show_individual: true,
      show_scores: false,
      show_consensus: false,
      show_dimension_heatmap: false,
      show_timing: false,
      copy_to_clipboard: true,
      tui_mode: 'never',
    },
    storage_security: { session_retention_days: 15 },
  };

  it('with a base: wizard-decided fields override, user-owned fields are preserved', () => {
    const result = assembleConfig({
      generalOverride: {
        default_chairman: 'new-chairman',
        role_generator_model: 'new-role-gen',
        min_agents: 2,
        max_agents: 5,
      },
      prefer: ['model-a', 'model-b'],
      chairman: 'new-chairman',
      base: customBase,
    });

    // --- wizard-decided fields: overridden ---
    expect(result.general.default_chairman).toBe('new-chairman');
    expect(result.general.role_generator_model).toBe('new-role-gen');
    expect(result.general.min_agents).toBe(2);
    expect(result.general.max_agents).toBe(5);
    expect(result.routing.default.prefer).toEqual(['model-a', 'model-b']);
    expect(result.routing.default.chairman).toBe('new-chairman');

    // --- user-owned fields: preserved untouched ---
    expect(result.general.high_risk_keywords).toEqual(['launch', 'deploy']);
    expect(result.general.review_rounds).toBe(3);
    expect(result.general.devil_advocate).toBe('always');
    expect(result.general.language).toBe('zh');
    expect(result.general.allow_same_model_agents).toBe(false);
    expect(result.general.compression_threshold_ratio).toBe(0.42);
    expect(result.general.default_mode).toBe('debate');

    expect(result.routing.strategy).toBe('llm');
    expect(result.routing.rules).toEqual([{ pattern: 'code', role_set: 'code-review' }]);
    expect(result.routing.default.role_set).toBe('custom-set');
    expect(result.routing.dynamic_weight_alpha).toBe(0.7);

    expect(result.storage).toEqual(customBase.storage);
    expect(result.concurrency.global_resource_limit).toBe(42);
    expect(result.circuit_breaker).toEqual(customBase.circuit_breaker);
    expect(result.output).toEqual(customBase.output);
    expect(result.storage_security).toEqual(customBase.storage_security);
    // schema_version is carried over from base, unaffected by the merge.
    expect(result.schema_version).toBe(1);
  });

  it('without a base: builds a complete config from schema defaults, schema_version 2 (standard-API convergence)', () => {
    const result = assembleConfig({
      generalOverride: {
        default_chairman: 'solo-model',
        role_generator_model: 'solo-model',
        min_agents: 1,
        max_agents: 3,
      },
      prefer: ['solo-model'],
      chairman: 'solo-model',
      base: null,
    });

    expect(result.general.role_generator_model).toBe('solo-model');
    expect(result.general.default_chairman).toBe('solo-model');
    expect(result.general.min_agents).toBe(1);
    expect(result.general.max_agents).toBe(3);

    // Schema defaults fill in everything the wizard didn't decide.
    expect(result.general.review_rounds).toBe(1);
    expect(result.general.high_risk_keywords).toEqual([]);
    expect(result.general.devil_advocate).toBe('auto');
    expect(result.routing.strategy).toBe('keyword');
    expect(result.routing.default.role_set).toBe('default');
    expect(result.concurrency.global_resource_limit).toBe(10);
    expect(result.output.format).toBe('markdown');
    expect(result.schema_version).toBe(2);
  });

  it('without a base: storage dirs come from PATHS, routing reflects the wizard choice', () => {
    const result = assembleConfig({
      generalOverride: {
        default_chairman: 'solo-model',
        role_generator_model: 'solo-model',
        min_agents: 1,
        max_agents: 3,
      },
      prefer: ['solo-model'],
      chairman: 'solo-model',
      base: null,
    });

    expect(result.storage.data_dir).toBe(PATHS.dataDir);
    expect(result.storage.checkpoint_dir).toBe(PATHS.checkpoints);
    expect(result.storage.log_dir).toBe(PATHS.logs);

    expect(result.routing.default.prefer).toEqual(['solo-model']);
    expect(result.routing.default.chairman).toBe('solo-model');
  });

  it('without a base and a single model (min_agents=1) is not rejected by schema validation', () => {
    const result = assembleConfig({
      generalOverride: { default_chairman: 'only-model', role_generator_model: '', min_agents: 1, max_agents: 3 },
      prefer: ['only-model'],
      chairman: 'only-model',
      base: null,
    });

    expect(result.general.min_agents).toBe(1);
    expect(result.general.role_generator_model).toBe('');
  });

  it('a prefer list with repeats is order-preserving de-duped (first occurrence wins)', () => {
    const result = assembleConfig({
      generalOverride: { default_chairman: 'a', role_generator_model: '', min_agents: 1, max_agents: 3 },
      prefer: ['a', 'b', 'a', 'c', 'b'],
      chairman: 'a',
      base: null,
    });

    expect(result.routing.default.prefer).toEqual(['a', 'b', 'c']);
  });

  it('is idempotent for an already-deduped input: re-assembling yields a stable result', () => {
    const once = assembleConfig({
      generalOverride: { default_chairman: 'a', role_generator_model: '', min_agents: 1, max_agents: 3 },
      prefer: ['a', 'b', 'a'],
      chairman: 'a',
      base: null,
    });
    const twice = assembleConfig({
      generalOverride: { default_chairman: 'a', role_generator_model: '', min_agents: 1, max_agents: 3 },
      prefer: once.routing.default.prefer,
      chairman: 'a',
      base: null,
    });

    expect(twice.routing.default.prefer).toEqual(once.routing.default.prefer);
    expect(twice.routing.default.prefer).toEqual(['a', 'b']);
  });
});

describe('dedupePrefer', () => {
  it('order-preserving de-dup, first occurrence wins', () => {
    expect(dedupePrefer(['b', 'a', 'b', 'c', 'a'])).toEqual(['b', 'a', 'c']);
  });

  it('an already-deduped list is returned as-is (idempotent)', () => {
    const clean = ['x', 'y', 'z'];
    expect(dedupePrefer(clean)).toEqual(clean);
    expect(dedupePrefer(dedupePrefer(clean))).toEqual(clean);
  });

  it('empty list → empty list', () => {
    expect(dedupePrefer([])).toEqual([]);
  });
});
