/**
 * Unified connectivity gate (src/ui/wizard/first-run.ts → verifyModelConnectivity)
 * shared by all three setup paths (Quick / custom official models / custom
 * endpoints). Verifies the single strategy they now all route through:
 *   - default: probe EVERY selected model in parallel (not just the chairman);
 *   - explicit skip: probe nothing;
 *   - failures: dropped by default, kept only via a per-model confirm.
 *
 * ApiAdapter.invoke is a spy (call count/args prove per-model probing) and
 * @inquirer/prompts.confirm is mocked to drive skip / per-failure decisions. The
 * mock is scoped to this file so it can't leak into the pure-function tests.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockConfirm } = vi.hoisted(() => ({ mockConfirm: vi.fn() }));

vi.mock('@inquirer/prompts', () => ({
  confirm: mockConfirm,
  select: vi.fn(),
  checkbox: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  Separator: class {
    separator: string;
    constructor(s = '') { this.separator = s; }
  },
}));

import { verifyModelConnectivity } from '../../../src/ui/wizard/first-run.js';
import {
  buildNamedModels,
  discoveredToModelConfig,
  buildCustomModelConfig,
} from '../../../src/providers/model-assembly.js';
import type { ModelConfig } from '../../../src/types/config.js';
import type { DiscoveredModel } from '../../../src/providers/model-discovery.js';
import type { ApiAdapter } from '../../../src/providers/api-adapter.js';

/** Minimal ModelConfig for gate tests — testConnectivity only reads `.name`. */
function cfg(name: string): ModelConfig {
  return { name, protocol: 'openai', model: name } as ModelConfig;
}

function disc(id: string, protocol: DiscoveredModel['protocol'] = 'openai'): DiscoveredModel {
  return { id, name: id, protocol, source: 'official' };
}

/**
 * Fake ApiAdapter whose invoke resolves for every model, unless the model's name
 * starts with `failPrefix` (then it rejects → testConnectivity reports failure).
 */
function fakeAdapter(invoke: ReturnType<typeof vi.fn>): ApiAdapter {
  return { invoke } as unknown as ApiAdapter;
}

const allPass = (): ReturnType<typeof vi.fn> => vi.fn().mockResolvedValue({ content: 'ok' });
const failWhen = (failPrefix: string): ReturnType<typeof vi.fn> =>
  vi.fn().mockImplementation((tc: { name: string }) =>
    tc.name.startsWith(failPrefix) ? Promise.reject(new Error('boom')) : Promise.resolve({ content: 'ok' }),
  );

beforeEach(() => {
  vi.clearAllMocks();
});

describe('verifyModelConnectivity — three-path parity (probe every selected model)', () => {
  it('Quick path shape (buildNamedModels configs): probes every model, not just the chairman', async () => {
    mockConfirm.mockResolvedValueOnce(false); // don't skip
    const configs = buildNamedModels([disc('gpt-4o'), disc('o3'), disc('claude-3-5-sonnet', 'anthropic')]).map(n => n.config);
    const invoke = allPass();

    const kept = await verifyModelConnectivity(configs, fakeAdapter(invoke));

    expect(invoke).toHaveBeenCalledTimes(configs.length); // one probe per model
    expect(kept).toHaveLength(configs.length);
  });

  it('custom-official path shape (discoveredToModelConfig): probes every model', async () => {
    mockConfirm.mockResolvedValueOnce(false);
    const configs = [disc('gpt-4o'), disc('claude-3-5-sonnet', 'anthropic')].map(m => discoveredToModelConfig(m));
    const invoke = allPass();

    const kept = await verifyModelConnectivity(configs, fakeAdapter(invoke));

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(kept.map(c => c.name)).toEqual(configs.map(c => c.name));
  });

  it('custom-endpoint path shape (buildCustomModelConfig): probes every model', async () => {
    mockConfirm.mockResolvedValueOnce(false);
    const configs = ['llama3.2', 'mistral'].map(id =>
      buildCustomModelConfig({ sanitizedName: 'ollama', modelId: id, baseUrl: 'http://localhost:11434/v1', protocol: 'openai' }),
    );
    const invoke = allPass();

    const kept = await verifyModelConnectivity(configs, fakeAdapter(invoke));

    expect(invoke).toHaveBeenCalledTimes(2);
    expect(kept).toHaveLength(2);
  });

  it('probes run in parallel (all invoked before any resolve)', async () => {
    mockConfirm.mockResolvedValueOnce(false);
    let inFlight = 0;
    let maxInFlight = 0;
    const invoke = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return { content: 'ok' };
    });

    await verifyModelConnectivity([cfg('a'), cfg('b'), cfg('c')], fakeAdapter(invoke));

    expect(maxInFlight).toBe(3); // all three launched concurrently
  });
});

describe('verifyModelConnectivity — explicit skip', () => {
  it('skipping testing never calls testConnectivity/invoke and keeps all models', async () => {
    mockConfirm.mockResolvedValueOnce(true); // skip = yes
    const invoke = vi.fn();

    const kept = await verifyModelConnectivity([cfg('a'), cfg('b')], fakeAdapter(invoke));

    expect(invoke).not.toHaveBeenCalled();
    expect(kept.map(c => c.name)).toEqual(['a', 'b']); // written unverified
    expect(mockConfirm).toHaveBeenCalledTimes(1); // only the skip prompt
  });
});

describe('verifyModelConnectivity — failure handling (per-model, consistent across paths)', () => {
  it('failed models are dropped by default via a per-model confirm (one confirm per failure, not one global)', async () => {
    // 1st confirm = skip (no); then one keep-confirm per failure.
    mockConfirm
      .mockResolvedValueOnce(false) // don't skip
      .mockResolvedValueOnce(false) // keep bad-1? no
      .mockResolvedValueOnce(false); // keep bad-2? no
    const invoke = failWhen('bad-');

    const kept = await verifyModelConnectivity([cfg('good-1'), cfg('bad-1'), cfg('bad-2')], fakeAdapter(invoke));

    expect(invoke).toHaveBeenCalledTimes(3); // all still probed
    expect(kept.map(c => c.name)).toEqual(['good-1']); // both failures dropped

    // Exactly one keep-prompt per failure, each naming that specific model.
    const keepPrompts = mockConfirm.mock.calls.slice(1).map(c => (c[0] as { message: string }).message);
    expect(keepPrompts).toHaveLength(2);
    expect(keepPrompts[0]).toContain('bad-1');
    expect(keepPrompts[1]).toContain('bad-2');
  });

  it('a failed model is retained when the user confirms that specific model (order preserved)', async () => {
    mockConfirm
      .mockResolvedValueOnce(false) // don't skip
      .mockResolvedValueOnce(true); // keep bad-1? yes
    const invoke = failWhen('bad-');

    const kept = await verifyModelConnectivity([cfg('good-1'), cfg('bad-1')], fakeAdapter(invoke));

    expect(kept.map(c => c.name)).toEqual(['good-1', 'bad-1']);
  });

  it('all-pass: no keep prompts, only the skip prompt', async () => {
    mockConfirm.mockResolvedValueOnce(false);
    const invoke = allPass();

    const kept = await verifyModelConnectivity([cfg('a'), cfg('b')], fakeAdapter(invoke));

    expect(kept.map(c => c.name)).toEqual(['a', 'b']);
    expect(mockConfirm).toHaveBeenCalledTimes(1); // skip prompt only, no per-failure confirms
  });
});

describe('verifyModelConnectivity — empty input', () => {
  it('short-circuits: no skip prompt, no probes', async () => {
    const invoke = vi.fn();
    const kept = await verifyModelConnectivity([], fakeAdapter(invoke));

    expect(kept).toEqual([]);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });
});
