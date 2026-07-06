/**
 * Tests for src/providers/model-assembly.ts after the standard-API convergence
 * (design-notes/standard-api-convergence.md §1.6): provider-family disambiguation
 * is gone — the only residual naming collision is "same model id from two
 * different base_urls" (an official endpoint and a custom one, or two customs).
 *
 * Pure functions — no mocking, no I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveModelNames,
  buildNamedModels,
  modelDedupeKey,
  discoveredToModelConfig,
  selectBestChairman,
  sanitizeProviderName,
  buildCustomModelConfig,
  customCredentialPath,
} from '../../src/providers/model-assembly.js';
import type { DiscoveredModel } from '../../src/providers/model-discovery.js';
import type { ModelConfig } from '../../src/types/config.js';
import { MODEL_CATALOG, MODEL_TIER_RULES } from '../../src/shared/model-catalog.js';
import { PATHS } from '../../src/config/paths.js';

/** An official model (no base_url) — the default shape most tests want. */
function official(id: string, protocol: 'anthropic' | 'openai' = 'anthropic'): DiscoveredModel {
  return { id, name: id, protocol, source: 'official' };
}

/** A custom-endpoint model — always carries a base_url and a source label. */
function custom(id: string, source: string, protocol: 'anthropic' | 'openai' = 'openai'): DiscoveredModel {
  return { id, name: id, protocol, source, base_url: `https://${source}.example.com/v1` };
}

describe('resolveModelNames — official vs. custom-endpoint disambiguation', () => {
  it('no collision → clean ids preserved', () => {
    const names = resolveModelNames([official('claude-opus-4', 'anthropic'), official('gpt-5', 'openai')]);
    expect(names).toEqual(['claude-opus-4', 'gpt-5']);
  });

  it('official model and a custom endpoint sharing an id: official keeps the bare name, custom gets a source suffix', () => {
    const names = resolveModelNames([official('gpt-4o'), custom('gpt-4o', 'deepseek-gw')]);
    expect(names).toEqual(['gpt-4o', 'gpt-4o-deepseek-gw']);
  });

  it('official wins the bare name regardless of list position', () => {
    const names = resolveModelNames([custom('gpt-4o', 'deepseek-gw'), official('gpt-4o')]);
    expect(names).toEqual(['gpt-4o-deepseek-gw', 'gpt-4o']);
  });

  it('two custom endpoints sharing an id (no official present): first occurrence keeps the bare name', () => {
    const names = resolveModelNames([custom('llama3', 'gw-a'), custom('llama3', 'gw-b')]);
    expect(names).toEqual(['llama3', 'llama3-gw-b']);
  });

  it('reordering the same two customs flips which one keeps the bare name', () => {
    const names = resolveModelNames([custom('llama3', 'gw-b'), custom('llama3', 'gw-a')]);
    expect(names).toEqual(['llama3', 'llama3-gw-a']);
  });

  it('a lone custom endpoint (no collision) keeps its clean id even though it is not official', () => {
    const names = resolveModelNames([custom('llama3', 'gw-a')]);
    expect(names).toEqual(['llama3']);
  });

  it('names stay unique even when multiple sources would slugify to the same suffix', () => {
    const names = resolveModelNames([custom('x', 'gw'), custom('x', 'gw'), custom('x', 'gw')]);
    expect(names).toEqual(['x', 'x-gw', 'x-gw-2']);
    expect(new Set(names).size).toBe(names.length);
  });

  it('an empty/unsanitizable source label falls back to a generic "custom" suffix', () => {
    const names = resolveModelNames([official('x'), { id: 'x', name: 'x', protocol: 'openai', source: '', base_url: 'https://h/v1' }]);
    expect(names).toEqual(['x', 'x-custom']);
  });
});

describe('buildNamedModels', () => {
  it('config.name matches resolveModelNames and config.base_url is preserved for dedupe', () => {
    const models = [official('gpt-4o'), custom('gpt-4o', 'deepseek-gw')];
    const named = buildNamedModels(models);

    expect(named.map((n) => n.config.name)).toEqual(['gpt-4o', 'gpt-4o-deepseek-gw']);
    expect(named[0]?.config.base_url).toBeUndefined();
    expect(named[1]?.config.base_url).toBe('https://deepseek-gw.example.com/v1');
    // Each NamedModel pairs the original DiscoveredModel with its shaped config.
    expect(named[0]?.model).toBe(models[0]);
  });
});

describe('modelDedupeKey — rescan identity is (name, base_url)', () => {
  it('same name + different base_url are distinct entries (no clobber)', () => {
    const a = modelDedupeKey({ name: 'gpt-4o', base_url: 'https://a.example.com/v1' });
    const b = modelDedupeKey({ name: 'gpt-4o', base_url: 'https://b.example.com/v1' });
    expect(a).not.toBe(b);
  });

  it('same name + same base_url collapse to one entry (idempotent re-import)', () => {
    const a = modelDedupeKey({ name: 'gpt-4o', base_url: 'https://a.example.com/v1' });
    const b = modelDedupeKey({ name: 'gpt-4o', base_url: 'https://a.example.com/v1' });
    expect(a).toBe(b);
  });

  it('official models (no base_url) collapse onto the "official" sentinel', () => {
    const a = modelDedupeKey({ name: 'claude-opus-4' });
    const b = modelDedupeKey({ name: 'claude-opus-4', base_url: undefined });
    expect(a).toBe(b);
    expect(a).toBe('claude-opus-4 official');
  });
});

describe('discoveredToModelConfig', () => {
  it('name defaults to discovered.id when omitted', () => {
    const cfg = discoveredToModelConfig(official('claude-opus-4-20250514'));
    expect(cfg.name).toBe('claude-opus-4-20250514');
  });

  it('an explicit name overrides discovered.id (model id is preserved separately)', () => {
    const cfg = discoveredToModelConfig(official('claude-opus-4-20250514'), 'custom-name');
    expect(cfg.name).toBe('custom-name');
    expect(cfg.model).toBe('claude-opus-4-20250514');
  });

  it('official (no base_url): provider derives from protocol, api_key_env from the shared catalog', () => {
    const cfg = discoveredToModelConfig(official('claude-opus-4-6', 'anthropic'));
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.base_url).toBeUndefined();
    expect(cfg.api_key_env).toBe(MODEL_CATALOG.anthropic.apiKeyEnv);
  });

  it('official anthropic vs. openai: priority is 100 vs. 90', () => {
    expect(discoveredToModelConfig(official('claude-x', 'anthropic')).priority).toBe(100);
    expect(discoveredToModelConfig(official('gpt-x', 'openai')).priority).toBe(90);
  });

  it('custom endpoint (has base_url): provider derives from the source label, no api_key_env, base_url passed through', () => {
    const cfg = discoveredToModelConfig(custom('llama3', 'my-gateway', 'openai'));
    expect(cfg.provider).toBe('my-gateway');
    expect(cfg.base_url).toBe('https://my-gateway.example.com/v1');
    expect(cfg.api_key_env).toBeUndefined();
  });

  it('always shapes a full, enabled, streaming-capable config', () => {
    const cfg = discoveredToModelConfig(official('gpt-5', 'openai'));
    expect(cfg.enabled).toBe(true);
    expect(cfg.streaming).toBe(true);
    expect(cfg.capabilities).toEqual(['general', 'code', 'analysis']);
    expect(cfg.timeout_seconds).toBe(120);
  });
});

describe('selectBestChairman', () => {
  function makeModel(overrides: Partial<ModelConfig> & { name: string; model: string }): ModelConfig {
    return {
      protocol: 'anthropic',
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

  it('a flagship model beats an unknown-tier model of the same protocol', () => {
    const flagship = makeModel({ name: 'claude-opus-4', model: 'claude-opus-4-20250514' });
    const unknown = makeModel({ name: 'mystery-model', model: 'mystery-model-v2' });

    expect(selectBestChairman([unknown, flagship])?.name).toBe('claude-opus-4');
  });

  it('within the same capability tier, the flagship-id tiebreaker decides (gpt-5 > claude-sonnet-4)', () => {
    const gptFive = makeModel({ name: 'gpt-5-turbo', model: 'gpt-5-turbo', protocol: 'openai' });
    const claudeSonnet = makeModel({ name: 'claude-sonnet-4', model: 'claude-sonnet-4-20250514' });

    expect(selectBestChairman([claudeSonnet, gptFive])?.name).toBe('gpt-5-turbo');
  });

  it('a custom (openai-protocol) endpoint proxying a Gemini flagship id is still recognised by the bonus table', () => {
    // Real scenario: Google's OpenAI-compatible endpoint hosting gemini-2.5-pro.
    const geminiViaCompat = makeModel({
      name: 'gemini-compat', model: 'gemini-2.5-pro', protocol: 'openai', base_url: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
    const genericGpt4o = makeModel({ name: 'gpt-4o', model: 'gpt-4o', protocol: 'openai' });

    expect(selectBestChairman([genericGpt4o, geminiViaCompat])?.name).toBe('gemini-compat');
  });

  it('gpt-5-mini no longer out-ranks a genuine same-tier flagship (gpt-4o) — old /gpt-5/ bonus bug fixed', () => {
    // Both are capability tier 2; the flagship tie-break must go to gpt-4o (rank 4)
    // now that gpt-5-mini is excluded from the gpt-5 flagship family (rank 0).
    const mini = makeModel({ name: 'gpt-5-mini', model: 'gpt-5-mini', protocol: 'openai' });
    const gpt4o = makeModel({ name: 'gpt-4o', model: 'gpt-4o', protocol: 'openai' });

    expect(selectBestChairman([mini, gpt4o])?.name).toBe('gpt-4o');
  });

  it('an empty config list returns undefined', () => {
    expect(selectBestChairman([])).toBeUndefined();
  });

  // Tightest possible tier-boundary case: the highest flagshipRank a model can
  // carry while STAYING in capability tier 2 is 8 (gpt-5 family — rank 9 belongs
  // to /opus/, which is itself tier 3, so no tier-2 model can reach it). That
  // gives tier 2 its maximum possible score (2*10+8=28). A tier-3 model with the
  // *minimum* bonus (rank 0, score 3*10+0=30) still wins by exactly 2 — proving
  // the doc comment's claim ("the ×10 gap between tiers can never be closed by
  // the bonus") holds even at its narrowest margin, not just in the wide-margin
  // cases covered above.
  it('narrowest possible tier boundary: tier-2 model at its maximum in-tier bonus (gpt-5 family, rank 8) still loses to a tier-3 model with zero bonus (margin of exactly 2)', () => {
    const tier2MaxBonus = makeModel({ name: 'gpt-5-turbo', model: 'gpt-5-turbo', protocol: 'openai' }); // tier 2, rank 8 → score 28
    const tier3ZeroBonus = makeModel({
      name: 'gemini-compat', model: 'gemini-2.5-pro', protocol: 'openai', base_url: 'https://x.example.com/v1',
    }); // tier 3 ("pro"), rank 0 → score 30

    expect(selectBestChairman([tier2MaxBonus, tier3ZeroBonus])?.name).toBe('gemini-compat');
  });

  // Structural invariant behind the boundary test above: if a future rule were
  // added with rank >= 10, the family bonus alone could vault a tier-2 model
  // (score up to 2*10+rank) past a tier-3 model with zero bonus (score 30),
  // silently breaking the "×10 gap can never be closed" guarantee documented on
  // selectBestChairman. Pin the invariant down structurally, not just by example.
  it('MODEL_TIER_RULES: every rank stays below 10 (the bonus can never close a full capability-tier gap)', () => {
    const maxRank = Math.max(...MODEL_TIER_RULES.map(r => r.rank));
    expect(maxRank).toBeLessThan(10);
  });
});

describe('sanitizeProviderName', () => {
  it('lowercases and replaces invalid characters with hyphens', () => {
    expect(sanitizeProviderName('MyService_1!')).toBe('myservice-1');
  });

  it('strips leading and trailing hyphens', () => {
    expect(sanitizeProviderName('---abc---')).toBe('abc');
  });

  it('an all-invalid input sanitizes to an empty string', () => {
    expect(sanitizeProviderName('!!!')).toBe('');
  });
});

describe('customCredentialPath', () => {
  it('joins the sanitized name into the custom-<name>.key filename under baseDir', () => {
    expect(customCredentialPath('mylab', '/tmp/creds')).toBe('/tmp/creds/custom-mylab.key');
  });

  it('defaults baseDir to the real credentials path (PATHS.credentials)', () => {
    expect(customCredentialPath('mylab')).toBe(customCredentialPath('mylab', PATHS.credentials));
  });
});

describe('buildCustomModelConfig', () => {
  it('shapes name/provider from sanitizedName, defaults protocol to openai', () => {
    const cfg = buildCustomModelConfig({ sanitizedName: 'mylab', modelId: 'llama3', baseUrl: 'http://localhost:11434/v1' });
    expect(cfg.name).toBe('custom:mylab:llama3');
    expect(cfg.provider).toBe('custom:mylab');
    expect(cfg.protocol).toBe('openai');
    expect(cfg.base_url).toBe('http://localhost:11434/v1');
    expect(cfg.api_key_path).toBeUndefined();
  });

  it('an explicit protocol overrides the openai default', () => {
    const cfg = buildCustomModelConfig({
      sanitizedName: 'proxy', modelId: 'claude-x', baseUrl: 'https://gw.example.com', protocol: 'anthropic',
    });
    expect(cfg.protocol).toBe('anthropic');
  });

  it('a credentialPath sets api_key_path; omitting it leaves the field unset (SEC-02: key never inline)', () => {
    const withCred = buildCustomModelConfig({
      sanitizedName: 'mylab', modelId: 'llama3', baseUrl: 'http://h/v1', credentialPath: '/creds/custom-mylab.key',
    });
    expect(withCred.api_key_path).toBe('/creds/custom-mylab.key');

    const noCred = buildCustomModelConfig({ sanitizedName: 'mylab', modelId: 'llama3', baseUrl: 'http://h/v1' });
    expect(noCred.api_key_path).toBeUndefined();
  });
});
