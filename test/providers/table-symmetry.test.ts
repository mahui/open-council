/**
 * Drift guard for the two provider-expansion tables that must agree:
 *
 *   - discovery time: OAUTH_ALSO_TRY (model-discovery.ts) — which generic providers a
 *     credentialed OAuth provider also lists models under.
 *   - call time: RELATED_PROVIDERS (api-adapter.ts) — which providers resolveModel/getApiKey
 *     will try when invoking a model saved under a given provider.
 *
 * If a provider can be *attached to a discovered model* (an OAUTH_ALSO_TRY key or value) but
 * has no RELATED_PROVIDERS key, that model becomes discoverable-yet-uncallable — exactly the
 * google-vertex regression this asserts against. These are compile-time constants, so the test
 * only imports and compares them (no mocking / no network).
 */
import { describe, it, expect } from 'vitest';
import { OAUTH_ALSO_TRY } from '../../src/providers/model-discovery.js';
import { RELATED_PROVIDERS } from '../../src/providers/api-adapter.js';
import { LEGACY_TO_PIAI } from '../../src/providers/credentials/discovery.js';

/** Every provider that OAUTH_ALSO_TRY can stamp onto a discovered model (keys ∪ values). */
function discoveredProviders(): Set<string> {
  const set = new Set<string>();
  for (const [key, vals] of Object.entries(OAUTH_ALSO_TRY)) {
    set.add(key);
    for (const v of vals) set.add(v);
  }
  return set;
}

describe('provider table symmetry (discovery ↔ call)', () => {
  it('every provider reachable via OAUTH_ALSO_TRY has a RELATED_PROVIDERS key', () => {
    const callKeys = new Set(Object.keys(RELATED_PROVIDERS));
    const missing = [...discoveredProviders()].filter((p) => !callKeys.has(p));
    expect(missing, `providers discoverable but not callable: ${missing.join(', ')}`).toEqual([]);
  });

  it('google-vertex specifically is covered on both sides (regression)', () => {
    expect(discoveredProviders().has('google-vertex')).toBe(true);
    expect(RELATED_PROVIDERS['google-vertex']).toBeDefined();
    // …and its candidate chain reaches a real Google OAuth credential source.
    expect(RELATED_PROVIDERS['google-vertex']).toContain('google-gemini-cli');
  });

  it('every RELATED_PROVIDERS candidate is resolvable to a credential source', () => {
    // A candidate provider must either be a LEGACY_TO_PIAI key, appear as a pi-ai value in
    // some LEGACY_TO_PIAI entry, or be a self-mapping (env-key) provider — otherwise
    // resolveModel could pick a provider getApiKey can never satisfy.
    const piaiTargets = new Set<string>(Object.keys(LEGACY_TO_PIAI));
    for (const vals of Object.values(LEGACY_TO_PIAI)) for (const v of vals) piaiTargets.add(v);
    // github-copilot is a self-contained OAuth provider (no legacy mapping needed).
    piaiTargets.add('github-copilot');

    const allCandidates = new Set<string>();
    for (const vals of Object.values(RELATED_PROVIDERS)) for (const v of vals) allCandidates.add(v);

    const orphans = [...allCandidates].filter((p) => !piaiTargets.has(p));
    expect(orphans, `call candidates with no credential mapping: ${orphans.join(', ')}`).toEqual([]);
  });

  it('LEGACY_TO_PIAI maps google-vertex onto the Google credential family', () => {
    expect(LEGACY_TO_PIAI['google-vertex']).toBeDefined();
    expect(LEGACY_TO_PIAI['google-vertex']).toContain('google');
    // The Google legacy family also lists vertex, so getPiaiProvider('google') can route it.
    expect(LEGACY_TO_PIAI['google']).toContain('google-vertex');
  });
});
