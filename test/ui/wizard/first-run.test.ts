/**
 * Tests for the wizard's own pure helpers (src/ui/wizard/first-run.ts) after the
 * standard-API convergence: no OAuth login, no CLI binary probing. Naming /
 * chairman-selection / custom-endpoint shaping now live in
 * src/providers/model-assembly.ts and are covered by
 * test/providers/model-assembly.test.ts instead of here.
 */
import { describe, it, expect } from 'vitest';
import {
  isRecommended,
  clampAgents,
  credentialHint,
  buildModelChoices,
  SHOW_ALL_VALUE,
} from '../../../src/ui/wizard/first-run.js';
import type { ModelCheckboxItem } from '../../../src/ui/wizard/first-run.js';
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

describe('buildModelChoices', () => {
  // Only choice rows carry a `value`; Separator headers do not.
  type Selectable = { name: string; value: string; checked: boolean };
  const selectable = (items: ModelCheckboxItem[]): Selectable[] =>
    items.filter((i): i is Selectable => 'value' in i);
  const findByValue = (items: ModelCheckboxItem[], value: string): Selectable | undefined =>
    selectable(items).find(c => c.value === value);
  const modelRows = (items: ModelCheckboxItem[]): Selectable[] =>
    selectable(items).filter(c => c.value !== SHOW_ALL_VALUE);

  const openaiModels = (n: number): DiscoveredModel[] =>
    Array.from({ length: n }, (_, i) =>
      makeDiscovered({ id: `model-${String(i).padStart(2, '0')}`, protocol: 'openai' }),
    );

  // 25 models (> threshold): 5 recommended flagships + 20 non-recommended fillers,
  // split across both protocols so grouping is exercised too.
  const mixedDiscovered = (): { models: DiscoveredModel[]; recommendedCount: number } => {
    const recommended = [
      makeDiscovered({ id: 'claude-opus-4-20250514', protocol: 'anthropic' }),
      makeDiscovered({ id: 'claude-sonnet-4-20250514', protocol: 'anthropic' }),
      makeDiscovered({ id: 'claude-3-5-sonnet-20241022', protocol: 'anthropic' }),
      makeDiscovered({ id: 'gpt-4o', protocol: 'openai' }),
      makeDiscovered({ id: 'gpt-5', protocol: 'openai' }),
    ];
    const filler = Array.from({ length: 20 }, (_, i) =>
      makeDiscovered({ id: `filler-${String(i).padStart(2, '0')}`, protocol: 'openai' }),
    );
    return { models: [...recommended, ...filler], recommendedCount: recommended.length };
  };

  it('total ≤ 20: no truncation, no "show all" row, every model present', () => {
    const models = [
      makeDiscovered({ id: 'claude-opus-4-20250514', protocol: 'anthropic' }), // recommended
      makeDiscovered({ id: 'claude-haiku-3-5', protocol: 'anthropic' }),        // not
      makeDiscovered({ id: 'gpt-4o', protocol: 'openai' }),                     // recommended
      makeDiscovered({ id: 'gpt-4o-mini', protocol: 'openai' }),               // not
    ];
    const { choices, hiddenCount } = buildModelChoices(models);

    expect(hiddenCount).toBe(0);
    expect(findByValue(choices, SHOW_ALL_VALUE)).toBeUndefined();
    expect(modelRows(choices)).toHaveLength(4); // ≤ 20 → nothing collapsed

    // isRecommended drives the default checked state when no checkedKeys given.
    const opus = modelRows(choices).find(c => c.name.startsWith('claude-opus'));
    const haiku = modelRows(choices).find(c => c.name.startsWith('claude-haiku'));
    expect(opus?.checked).toBe(true);
    expect(haiku?.checked).toBe(false);
  });

  // Acceptance criterion 1: > 20 collapses to recommended items + one disclosure row.
  it('total > 20: shows recommended items + a single "show all / N hidden" row', () => {
    const { models, recommendedCount } = mixedDiscovered();
    const { choices, hiddenCount } = buildModelChoices(models);

    // non-Separator items == recommended count + the one "show all" row
    expect(selectable(choices)).toHaveLength(recommendedCount + 1);
    expect(hiddenCount).toBe(models.length - recommendedCount); // 20 hidden

    // the disclosure row exists and states how many were hidden
    const showAllRow = findByValue(choices, SHOW_ALL_VALUE);
    expect(showAllRow).toBeDefined();
    expect(showAllRow?.name).toContain(String(hiddenCount));

    // every visible model row is a recommended flagship, no filler leaked in
    const visible = modelRows(choices);
    expect(visible).toHaveLength(recommendedCount);
    expect(visible.every(c => !c.name.includes('filler'))).toBe(true);

    // the per-protocol header also spells out how many were held back (openai: 2 of 22)
    const headers = choices.filter(i => !('value' in i)) as { separator: string }[];
    expect(headers.some(h => h.separator.includes('showing 2 of 22'))).toBe(true);
  });

  // Acceptance criterion 2: the "show all" view returns every discovered model per protocol.
  it('"show all" view returns every discovered model, grouped by protocol', () => {
    const { models } = mixedDiscovered();
    const { choices, hiddenCount } = buildModelChoices(models, { showAll: true });

    expect(hiddenCount).toBe(0);
    expect(findByValue(choices, SHOW_ALL_VALUE)).toBeUndefined();

    const shown = modelRows(choices);
    expect(shown).toHaveLength(models.length); // all 25 present

    const anthropicCount = models.filter(m => m.protocol === 'anthropic').length;
    const openaiCount = models.filter(m => m.protocol === 'openai').length;
    expect(shown.filter(c => c.name.includes('[anthropic]'))).toHaveLength(anthropicCount);
    expect(shown.filter(c => c.name.includes('[openai]'))).toHaveLength(openaiCount);
  });

  it('boundary: 20 models render in full, 21 (none recommended) collapse behind "show all"', () => {
    // 20 ≤ threshold → full list, no disclosure row
    const at = buildModelChoices(openaiModels(20));
    expect(at.hiddenCount).toBe(0);
    expect(modelRows(at.choices)).toHaveLength(20);
    expect(findByValue(at.choices, SHOW_ALL_VALUE)).toBeUndefined();

    // 21 > threshold with nothing recommended → everything disclosed behind the row
    const over = buildModelChoices(openaiModels(21));
    expect(over.hiddenCount).toBe(21);
    expect(modelRows(over.choices)).toHaveLength(0);
    expect(findByValue(over.choices, SHOW_ALL_VALUE)).toBeDefined();
  });

  it('show-all rebuild preserves the user selection via checkedKeys', () => {
    const models = openaiModels(25);
    // Discover the real value keys from an untruncated build (avoids duplicating modelKey()).
    const allKeys = modelRows(buildModelChoices(models, { showAll: true }).choices).map(c => c.value);
    expect(allKeys).toHaveLength(25);

    const preserved = new Set([allKeys[0]!, allKeys[10]!, allKeys[24]!]);
    const { choices, hiddenCount } = buildModelChoices(models, { showAll: true, checkedKeys: preserved });

    expect(hiddenCount).toBe(0);
    expect(findByValue(choices, SHOW_ALL_VALUE)).toBeUndefined();

    const rows = modelRows(choices);
    expect(rows).toHaveLength(25); // every model revealed after "show all"
    const checked = new Set(rows.filter(c => c.checked).map(c => c.value));
    expect(checked).toEqual(preserved); // exactly the preserved selection, nothing more
  });

  it('checkedKeys overrides the isRecommended default (a recommended model can start unchecked)', () => {
    const models = [
      makeDiscovered({ id: 'gpt-4o', protocol: 'openai' }),       // recommended by default
      makeDiscovered({ id: 'gpt-4o-mini', protocol: 'openai' }), // not
    ];
    const { choices } = buildModelChoices(models, { showAll: true, checkedKeys: new Set() });
    expect(modelRows(choices).every(c => c.checked === false)).toBe(true);
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
