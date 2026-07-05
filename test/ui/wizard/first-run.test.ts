import { describe, it, expect } from 'vitest';
import {
  selectBestChairman,
  isRecommended,
  discoveredToModelConfig,
  buildNamedModels,
  assembleConfig,
  clampAgents,
  credentialHint,
} from '../../../src/ui/wizard/first-run.js';
import type { ModelConfig, CouncilConfig } from '../../../src/types/config.js';
import type { DiscoveredModel } from '../../../src/providers/model-discovery.js';
import { PATHS } from '../../../src/config/paths.js';

/** Minimal, schema-shaped ModelConfig builder — every field the wizard's pure
 *  helpers actually read is explicit; the rest are innocuous defaults. */
function makeModel(overrides: Partial<ModelConfig> & { name: string }): ModelConfig {
  return {
    invocation: 'api',
    provider: 'anthropic',
    timeout_seconds: 120,
    capabilities: ['general'],
    priority: 100,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: true,
    ...overrides,
  };
}

function makeDiscovered(overrides: Partial<DiscoveredModel> & { id: string }): DiscoveredModel {
  return {
    name: overrides.id,
    provider: 'anthropic',
    invocation: 'api',
    ...overrides,
  };
}

describe('selectBestChairman', () => {
  it('旗舰 API 模型 > CLI 模型 > 未知模型', () => {
    const flagshipApi = makeModel({ name: 'claude-opus-4', model: 'claude-opus-4-20250514', invocation: 'api' });
    const cliModel = makeModel({ name: 'custom-model-v1-cli', model: 'custom-model-v1', invocation: 'cli' });
    const unknownApi = makeModel({ name: 'custom-model-v2', model: 'custom-model-v2', invocation: 'api' });

    // Shuffle input order — result must not depend on array position.
    const best = selectBestChairman([unknownApi, cliModel, flagshipApi]);

    expect(best?.name).toBe('claude-opus-4');
  });

  it('CLI 模型优于同能力档位的未知 API 模型（invocation bonus）', () => {
    const cliModel = makeModel({ name: 'custom-model-v1-cli', model: 'custom-model-v1', invocation: 'cli' });
    const unknownApi = makeModel({ name: 'custom-model-v2', model: 'custom-model-v2', invocation: 'api' });

    const best = selectBestChairman([unknownApi, cliModel]);

    expect(best?.name).toBe('custom-model-v1-cli');
  });

  it('同能力档位内，tiebreaker 按旗舰加分区分（gpt-5 > claude-sonnet-4）', () => {
    const gptFive = makeModel({ name: 'gpt-5-turbo', model: 'gpt-5-turbo', invocation: 'api' });
    const claudeSonnet = makeModel({ name: 'claude-sonnet-4', model: 'claude-sonnet-4-20250514', invocation: 'api' });

    // Both land in the "balanced" capability tier (rateModelCapability === 2);
    // only the flagship-id tiebreaker should separate them.
    const best = selectBestChairman([claudeSonnet, gptFive]);

    expect(best?.name).toBe('gpt-5-turbo');
  });

  it('空配置列表 → 返回 undefined', () => {
    expect(selectBestChairman([])).toBeUndefined();
  });
});

describe('isRecommended', () => {
  it.each<[string, Partial<DiscoveredModel>, boolean]>([
    ['CLI 模型总是推荐（即便 id 看似普通）', { id: 'anything-goes', invocation: 'cli' }, true],
    ['Anthropic opus', { id: 'claude-opus-4-20250514', invocation: 'api' }, true],
    ['Anthropic sonnet-4', { id: 'claude-sonnet-4-20250514', invocation: 'api' }, true],
    ['Anthropic 3-5-sonnet', { id: 'claude-3-5-sonnet-20241022', invocation: 'api' }, true],
    ['OpenAI o3', { id: 'o3', invocation: 'api' }, true],
    ['OpenAI o4', { id: 'o4', invocation: 'api' }, true],
    ['OpenAI gpt-4o', { id: 'gpt-4o', invocation: 'api' }, true],
    ['OpenAI gpt-5', { id: 'gpt-5', invocation: 'api' }, true],
    ['OpenAI gpt-5-turbo (无 mini 后缀)', { id: 'gpt-5-turbo', invocation: 'api' }, true],
    ['Google gemini-2.5-pro', { id: 'gemini-2.5-pro', invocation: 'api' }, true],
    ['Google gemini-pro', { id: 'gemini-pro', invocation: 'api' }, true],

    ['Anthropic haiku 被排除', { id: 'claude-haiku-3-5', invocation: 'api' }, false],
    ['OpenAI gpt-4o-mini 被排除（非精确 gpt-4o）', { id: 'gpt-4o-mini', invocation: 'api' }, false],
    ['OpenAI gpt-5-mini 被排除', { id: 'gpt-5-mini', invocation: 'api' }, false],
    ['OpenAI o1 不在推荐白名单', { id: 'o1', invocation: 'api' }, false],
    ['Google gemini-2.5-flash 被排除', { id: 'gemini-2.5-flash', invocation: 'api' }, false],
    ['Google gemini-1.5-pro 与旗舰版本号不符，被排除', { id: 'gemini-1.5-pro', invocation: 'api' }, false],
    ['未知供应商模型被排除', { id: 'llama-3-70b-instruct', invocation: 'api', provider: 'other' }, false],
  ])('%s', (_label, overrides, expected) => {
    expect(isRecommended(makeDiscovered(overrides))).toBe(expected);
  });
});

describe('discoveredToModelConfig', () => {
  it('name 省略时默认取 discovered.id', () => {
    const m = makeDiscovered({ id: 'claude-opus-4-20250514', provider: 'anthropic', invocation: 'api' });
    const cfg = discoveredToModelConfig(m);
    expect(cfg.name).toBe('claude-opus-4-20250514');
  });

  it('显式 name 覆盖 discovered.id', () => {
    const m = makeDiscovered({ id: 'claude-opus-4-20250514', provider: 'anthropic', invocation: 'api' });
    const cfg = discoveredToModelConfig(m, 'custom-name');
    expect(cfg.name).toBe('custom-name');
    expect(cfg.model).toBe('claude-opus-4-20250514');
  });

  it.each<[string, string, number]>([
    ['anthropic', 'anthropic', 100],
    ['openai', 'openai', 90],
    ['openai-codex', 'openai-codex', 90],
    ['google', 'google', 80],
    ['custom:local', 'custom:local', 80],
  ])('provider=%s → priority=%i', (_label, provider, expectedPriority) => {
    const m = makeDiscovered({ id: 'model-x', provider, invocation: 'api' });
    const cfg = discoveredToModelConfig(m);
    expect(cfg.priority).toBe(expectedPriority);
    expect(cfg.streaming).toBe(true);
    expect(cfg.binary).toBeUndefined();
  });

  it('CLI + anthropic → claude 二进制与 arg 参数', () => {
    const m = makeDiscovered({ id: 'claude-opus-4-20250514', provider: 'anthropic', invocation: 'cli' });
    const cfg = discoveredToModelConfig(m);
    expect(cfg.binary).toBe('claude');
    expect(cfg.args).toEqual(['-p', '--model', 'claude-opus-4-20250514']);
    expect(cfg.input_mode).toBe('arg');
    expect(cfg.streaming).toBe(false);
  });

  it('CLI + openai → codex 二进制与 exec 参数', () => {
    const m = makeDiscovered({ id: 'gpt-5', provider: 'openai', invocation: 'cli' });
    const cfg = discoveredToModelConfig(m);
    expect(cfg.binary).toBe('codex');
    expect(cfg.args).toEqual(['exec', '-m', 'gpt-5', '-c', 'approval_policy="never"', '--json']);
    expect(cfg.input_mode).toBe('arg');
  });

  it('CLI + google → gemini 二进制', () => {
    const m = makeDiscovered({ id: 'gemini-2.5-pro', provider: 'google', invocation: 'cli' });
    const cfg = discoveredToModelConfig(m);
    expect(cfg.binary).toBe('gemini');
    expect(cfg.args).toEqual(['-p']);
    expect(cfg.input_mode).toBe('arg');
  });
});

describe('buildNamedModels', () => {
  it('API 与 CLI 共享同一 id 时，仅 CLI 变体加 -cli 后缀', () => {
    const models: DiscoveredModel[] = [
      makeDiscovered({ id: 'gemini-2.5-pro', name: 'gemini-2.5-pro (api)', provider: 'google', invocation: 'api' }),
      makeDiscovered({ id: 'gemini-2.5-pro', name: 'gemini-2.5-pro (cli)', provider: 'google', invocation: 'cli' }),
    ];

    const named = buildNamedModels(models);
    const apiNamed = named.find(n => n.model.invocation === 'api');
    const cliNamed = named.find(n => n.model.invocation === 'cli');

    expect(apiNamed?.config.name).toBe('gemini-2.5-pro');
    expect(cliNamed?.config.name).toBe('gemini-2.5-pro-cli');
  });

  it('无 id 冲突时名字保持干净（不加后缀），即便是唯一的 CLI 模型', () => {
    const models: DiscoveredModel[] = [
      makeDiscovered({ id: 'gpt-5', name: 'gpt-5', provider: 'openai', invocation: 'cli' }),
    ];

    const named = buildNamedModels(models);

    expect(named[0]?.config.name).toBe('gpt-5');
  });

  it('无冲突的多个不同 id 模型均保持各自 id 作为 name', () => {
    const models: DiscoveredModel[] = [
      makeDiscovered({ id: 'claude-opus-4', name: 'claude-opus-4', provider: 'anthropic', invocation: 'api' }),
      makeDiscovered({ id: 'gpt-5', name: 'gpt-5', provider: 'openai', invocation: 'api' }),
    ];

    const named = buildNamedModels(models);

    expect(named.map(n => n.config.name).sort()).toEqual(['claude-opus-4', 'gpt-5']);
  });

  it('prefer 列表引用的是冲突消解后的最终 name，而非原始 discovered.id', () => {
    const models: DiscoveredModel[] = [
      makeDiscovered({ id: 'gemini-2.5-pro', name: 'a', provider: 'google', invocation: 'api' }),
      makeDiscovered({ id: 'gemini-2.5-pro', name: 'b', provider: 'google', invocation: 'cli' }),
    ];

    const named = buildNamedModels(models);
    const prefer = named.map(n => n.config.name);

    expect(prefer).toEqual(['gemini-2.5-pro', 'gemini-2.5-pro-cli']);
    // Distinct entries — the whole point of the collision resolution.
    expect(new Set(prefer).size).toBe(prefer.length);
    // Each NamedModel's config.name is what downstream code (prefer/chairman) reads;
    // reconfirm it matches what we just derived, not the raw model.id.
    for (const n of named) {
      expect(n.config.name).toBe(prefer.find(p => p === n.config.name));
    }
  });
});

describe('clampAgents', () => {
  it('1 个模型时 → { min: 1, max: 3 }（多角色单模型场景）', () => {
    expect(clampAgents(1)).toEqual({ min: 1, max: 3 });
  });

  it('2 个模型时 → { min: 2, max: 2 }', () => {
    expect(clampAgents(2)).toEqual({ min: 2, max: 2 });
  });

  it('3 个模型时 → { min: 2, max: 3 }', () => {
    expect(clampAgents(3)).toEqual({ min: 2, max: 3 });
  });

  it('5 个及以上模型时 → max 封顶为 5', () => {
    expect(clampAgents(5)).toEqual({ min: 2, max: 5 });
    expect(clampAgents(10)).toEqual({ min: 2, max: 5 });
  });
});

describe('credentialHint', () => {
  it.each<[string, string]>([
    ['anthropic', 'claude login'],
    ['Anthropic', 'claude login'],
    ['openai', 'codex login'],
    ['openai-codex', 'codex login'],
    ['google', 'gemini` and sign in'],
    ['google-gemini-cli', 'gemini` and sign in'],
    ['google-vertex', 'gemini` and sign in'],
    ['github-copilot', 'gh auth login'],
    ['some-unknown-provider', 'check the credential file'],
  ])('provider=%s → 命中对应提示', (provider, expectedSubstring) => {
    expect(credentialHint(provider)).toContain(expectedSubstring);
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

  it('有 base 时：用户手改字段保留，向导决定的字段被覆盖', () => {
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
  });

  it('无 base 时：从 schema 默认值生成完整配置，且包含向导指定的 role_generator_model', () => {
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
    expect(result.schema_version).toBe(1);
  });
  it('无 base 时 storage 目录来自 PATHS，routing 反映向导选择', () => {
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

    // Storage dirs come from PATHS, not schema string defaults, when base is absent.
    expect(result.storage.data_dir).toBe(PATHS.dataDir);
    expect(result.storage.checkpoint_dir).toBe(PATHS.checkpoints);
    expect(result.storage.log_dir).toBe(PATHS.logs);

    expect(result.routing.default.prefer).toEqual(['solo-model']);
    expect(result.routing.default.chairman).toBe('solo-model');
  });

  it('无 base 且单模型时（min_agents=1）不会被 schema 校验拒绝', () => {
    const result = assembleConfig({
      generalOverride: { default_chairman: 'only-model', role_generator_model: '', min_agents: 1, max_agents: 3 },
      prefer: ['only-model'],
      chairman: 'only-model',
      base: null,
    });

    expect(result.general.min_agents).toBe(1);
    expect(result.general.role_generator_model).toBe('');
  });
});
