/**
 * Tests for the multi-source disambiguation in model-assembly.ts:
 *  - resolveModelNames / buildNamedModels: bare name goes to the family's main API source;
 *    other API sources get a provider suffix; CLI keeps `-cli`; names stay globally unique.
 *  - modelDedupeKey: rescan upsert identity is (name, provider), not name alone.
 *
 * Pure functions — no mocking, no I/O.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveModelNames,
  buildNamedModels,
  modelDedupeKey,
} from '../../src/providers/model-assembly.js';
import type { DiscoveredModel } from '../../src/providers/model-discovery.js';

function m(id: string, provider: string, invocation: 'api' | 'cli' = 'api'): DiscoveredModel {
  return { id, name: `${id} (${provider})`, provider, invocation };
}

describe('resolveModelNames — multi API-source disambiguation', () => {
  it('same id across two API providers: main source keeps bare name, other gets provider suffix', () => {
    const names = resolveModelNames([
      m('gemini-2.5-pro', 'google'),
      m('gemini-2.5-pro', 'google-vertex'),
    ]);
    expect(names).toEqual(['gemini-2.5-pro', 'gemini-2.5-pro-vertex']);
  });

  it('openai vs openai-codex API sources: openai stays bare, codex pool gets -codexapi', () => {
    const names = resolveModelNames([
      m('gpt-5.1', 'openai-codex'),
      m('gpt-5.1', 'openai'),
    ]);
    // Order-independent: the main provider (openai) wins the bare name regardless of input order.
    expect(names[1]).toBe('gpt-5.1');
    expect(names[0]).toBe('gpt-5.1-codexapi');
  });

  it('non-main API source stays bare when it is the only source present (real Vertex-only env)', () => {
    // The reported user env: only the Vertex entry survived — it should keep the clean id.
    const names = resolveModelNames([m('gemini-2.5-pro', 'google-vertex')]);
    expect(names).toEqual(['gemini-2.5-pro']);
  });

  it('three-way collision: main API bare, other API suffixed, CLI -cli — all unique', () => {
    const names = resolveModelNames([
      m('gemini-2.5-pro', 'google'),
      m('gemini-2.5-pro', 'google-vertex'),
      m('gemini-2.5-pro', 'google', 'cli'),
    ]);
    expect(names).toEqual([
      'gemini-2.5-pro',
      'gemini-2.5-pro-vertex',
      'gemini-2.5-pro-cli',
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('API always outranks CLI for the bare name even when CLI is listed first', () => {
    const names = resolveModelNames([
      m('gemini-2.5-pro', 'google', 'cli'),
      m('gemini-2.5-pro', 'google-vertex'),
    ]);
    expect(names).toEqual(['gemini-2.5-pro-cli', 'gemini-2.5-pro']);
  });

  it('names are guaranteed unique even for an unforeseen same-suffix collision', () => {
    // Two variants that would both slugify to the same base still resolve distinctly.
    const names = resolveModelNames([
      m('x', 'google-vertex'),
      m('x', 'google-vertex'),
    ]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('no collision → clean ids preserved', () => {
    const names = resolveModelNames([
      m('claude-opus-4', 'anthropic'),
      m('gpt-5', 'openai'),
    ]);
    expect(names).toEqual(['claude-opus-4', 'gpt-5']);
  });
});

describe('buildNamedModels — config carries the disambiguated name (provider preserved)', () => {
  it('each config.name matches resolveModelNames and provider is retained for dedupe', () => {
    const models = [m('gemini-2.5-pro', 'google'), m('gemini-2.5-pro', 'google-vertex')];
    const named = buildNamedModels(models);
    expect(named.map((n) => n.config.name)).toEqual(['gemini-2.5-pro', 'gemini-2.5-pro-vertex']);
    // Provider survives onto the config so (name, provider) dedupe stays meaningful.
    expect(named[0]?.config.provider).toBe('google');
    expect(named[1]?.config.provider).toBe('google-vertex');
  });
});

describe('modelDedupeKey — rescan identity is (name, provider)', () => {
  it('same name + different provider are distinct entries (no clobber)', () => {
    const a = modelDedupeKey({ name: 'gemini-2.5-pro', provider: 'google' });
    const b = modelDedupeKey({ name: 'gemini-2.5-pro', provider: 'google-vertex' });
    expect(a).not.toBe(b);
  });

  it('same name + same provider collapse to one entry (idempotent re-import)', () => {
    const a = modelDedupeKey({ name: 'gpt-5', provider: 'openai' });
    const b = modelDedupeKey({ name: 'gpt-5', provider: 'openai' });
    expect(a).toBe(b);
  });

  it('missing provider is tolerated and still keyed deterministically', () => {
    expect(modelDedupeKey({ name: 'solo' })).toBe(modelDedupeKey({ name: 'solo' }));
  });
});
