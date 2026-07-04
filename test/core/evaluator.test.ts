/**
 * Tests for benchmark evaluation logic (src/core/evaluator.ts).
 *
 * evaluator.ts is pure logic (ARCH-01, no I/O): it takes an injected
 * InvocationAdapter (TEST-03 — we mock the adapter boundary, not internal
 * evaluator functions) and an optional onWarn callback instead of writing to
 * stderr directly. These tests assert the input/output contract: given a
 * judge-model response, what coverage/error score comes out, and when onWarn
 * fires.
 */
import { describe, it, expect, vi } from 'vitest';
import { evaluateCoverage, evaluateErrors } from '../../src/core/evaluator.js';
import type { InvocationAdapter, InvocationResult } from '../../src/types/provider.js';
import type { ModelConfig } from '../../src/types/config.js';

function judgeModel(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    name: 'judge-model',
    invocation: 'api',
    provider: 'anthropic',
    model: 'claude-judge',
    timeout_seconds: 60,
    capabilities: ['general'],
    priority: 50,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: false,
    ...overrides,
  };
}

function makeAdapter(response: string | (() => Promise<string>)): InvocationAdapter {
  return {
    invoke: vi.fn(async (): Promise<InvocationResult> => {
      const text = typeof response === 'function' ? await response() : response;
      return {
        response: text,
        elapsed_ms: 10,
        invocation_mode: 'api',
        timed_out: false,
      };
    }),
    healthCheck: vi.fn(),
  };
}

function rejectingAdapter(err: unknown): InvocationAdapter {
  return {
    invoke: vi.fn().mockRejectedValue(err),
    healthCheck: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// evaluateCoverage
// ---------------------------------------------------------------------------

describe('evaluateCoverage', () => {
  it('no expected points → score 0, empty details, adapter never invoked', async () => {
    const adapter = makeAdapter('should not be read');

    const result = await evaluateCoverage('Q?', 'response text', [], adapter, judgeModel());

    expect(result).toEqual({ score: 0, details: [] });
    expect(adapter.invoke).not.toHaveBeenCalled();
  });

  it('all points "yes" → weighted score 1.0', async () => {
    const adapter = makeAdapter(JSON.stringify([
      { point: 'point A', covered: 'yes' },
      { point: 'point B', covered: 'yes' },
    ]));

    const result = await evaluateCoverage('Q?', 'resp', ['point A', 'point B'], adapter, judgeModel());

    expect(result.score).toBe(1.0);
    expect(result.details).toHaveLength(2);
  });

  it('mixed yes/partial/no → weighted average (1.0 + 0.5 + 0) / 3', async () => {
    const adapter = makeAdapter(JSON.stringify([
      { point: 'A', covered: 'yes' },
      { point: 'B', covered: 'partial' },
      { point: 'C', covered: 'no' },
    ]));

    const result = await evaluateCoverage('Q?', 'resp', ['A', 'B', 'C'], adapter, judgeModel());

    expect(result.score).toBeCloseTo(0.5, 5);
  });

  it('response wrapped in a ```json code fence → fence stripped before parsing', async () => {
    const fenced = '```json\n' + JSON.stringify([{ point: 'A', covered: 'yes' }]) + '\n```';
    const adapter = makeAdapter(fenced);

    const result = await evaluateCoverage('Q?', 'resp', ['A'], adapter, judgeModel());

    expect(result.score).toBe(1.0);
    expect(result.details).toEqual([{ point: 'A', covered: 'yes' }]);
  });

  it('response wrapped in a plain ``` fence (no "json" tag) → also stripped', async () => {
    const fenced = '```\n' + JSON.stringify([{ point: 'A', covered: 'no' }]) + '\n```';
    const adapter = makeAdapter(fenced);

    const result = await evaluateCoverage('Q?', 'resp', ['A'], adapter, judgeModel());

    expect(result.score).toBe(0);
    expect(result.details).toEqual([{ point: 'A', covered: 'no' }]);
  });

  it('malformed JSON → graceful degradation: score 0, empty details, onWarn fires with "parse failed"', async () => {
    const adapter = makeAdapter('not json at all {{{');
    const onWarn = vi.fn();

    const result = await evaluateCoverage('Q?', 'resp', ['A'], adapter, judgeModel(), onWarn);

    expect(result).toEqual({ score: 0, details: [] });
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]![0]).toContain('coverage parse failed');
  });

  it('JSON response is not an array → graceful degradation via parse failure path', async () => {
    const adapter = makeAdapter(JSON.stringify({ point: 'A', covered: 'yes' }));
    const onWarn = vi.fn();

    const result = await evaluateCoverage('Q?', 'resp', ['A'], adapter, judgeModel(), onWarn);

    expect(result).toEqual({ score: 0, details: [] });
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('coverage parse failed'));
  });

  it('invalid "covered" value in an item → treated as parse failure (score 0)', async () => {
    const adapter = makeAdapter(JSON.stringify([{ point: 'A', covered: 'maybe' }]));
    const onWarn = vi.fn();

    const result = await evaluateCoverage('Q?', 'resp', ['A'], adapter, judgeModel(), onWarn);

    expect(result).toEqual({ score: 0, details: [] });
    expect(onWarn).toHaveBeenCalled();
  });

  it('adapter.invoke rejects → graceful degradation: score 0, onWarn fires with "invoke failed"', async () => {
    const adapter = rejectingAdapter(new Error('network unreachable'));
    const onWarn = vi.fn();

    const result = await evaluateCoverage('Q?', 'resp', ['A'], adapter, judgeModel(), onWarn);

    expect(result).toEqual({ score: 0, details: [] });
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]![0]).toContain('coverage invoke failed');
    expect(onWarn.mock.calls[0]![0]).toContain('network unreachable');
  });

  it('adapter.invoke rejects with a non-Error value → message still stringified', async () => {
    const adapter = rejectingAdapter('plain string rejection');
    const onWarn = vi.fn();

    await evaluateCoverage('Q?', 'resp', ['A'], adapter, judgeModel(), onWarn);

    expect(onWarn.mock.calls[0]![0]).toContain('plain string rejection');
  });

  it('onWarn omitted entirely → failure path does not throw (core stays I/O-free by default)', async () => {
    const adapter = makeAdapter('not json');

    await expect(evaluateCoverage('Q?', 'resp', ['A'], adapter, judgeModel())).resolves.toEqual({
      score: 0,
      details: [],
    });
  });

  it('extra items beyond expectedPoints.length are ignored (sliced to expected count)', async () => {
    const adapter = makeAdapter(JSON.stringify([
      { point: 'A', covered: 'yes' },
      { point: 'B', covered: 'yes' },
      { point: 'unexpected-extra', covered: 'no' },
    ]));

    const result = await evaluateCoverage('Q?', 'resp', ['A', 'B'], adapter, judgeModel());

    expect(result.details).toHaveLength(2);
    expect(result.score).toBe(1.0);
  });

  it('missing "point"/"covered" fields default to "" / "no"', async () => {
    const adapter = makeAdapter(JSON.stringify([{}]));

    const result = await evaluateCoverage('Q?', 'resp', ['A'], adapter, judgeModel());

    expect(result.details).toEqual([{ point: '', covered: 'no' }]);
    expect(result.score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateErrors
// ---------------------------------------------------------------------------

describe('evaluateErrors', () => {
  const traps = [{ type: 'off-by-one', description: 'classic off-by-one trap' }];

  it('no known traps → errorRate 0, errorScore 1.0, adapter never invoked', async () => {
    const adapter = makeAdapter('should not be read');

    const result = await evaluateErrors('Q?', 'resp', [], adapter, judgeModel());

    expect(result).toEqual({ errorRate: 0, errorScore: 1.0, details: [] });
    expect(adapter.invoke).not.toHaveBeenCalled();
  });

  it('trap triggered → errorRate 1.0, errorScore 0', async () => {
    const adapter = makeAdapter(JSON.stringify([{ trap: 'off-by-one', triggered: true }]));

    const result = await evaluateErrors('Q?', 'resp', traps, adapter, judgeModel());

    expect(result.errorRate).toBe(1.0);
    expect(result.errorScore).toBe(0);
  });

  it('trap not triggered → errorRate 0, errorScore 1.0', async () => {
    const adapter = makeAdapter(JSON.stringify([{ trap: 'off-by-one', triggered: false }]));

    const result = await evaluateErrors('Q?', 'resp', traps, adapter, judgeModel());

    expect(result.errorRate).toBe(0);
    expect(result.errorScore).toBe(1.0);
  });

  it('mixed triggered traps → errorRate is the fraction triggered', async () => {
    const twoTraps = [
      { type: 't1', description: 'trap one' },
      { type: 't2', description: 'trap two' },
    ];
    const adapter = makeAdapter(JSON.stringify([
      { trap: 't1', triggered: true },
      { trap: 't2', triggered: false },
    ]));

    const result = await evaluateErrors('Q?', 'resp', twoTraps, adapter, judgeModel());

    expect(result.errorRate).toBe(0.5);
    expect(result.errorScore).toBe(0.5);
  });

  it('response wrapped in a code fence → stripped before parsing', async () => {
    const fenced = '```json\n' + JSON.stringify([{ trap: 'off-by-one', triggered: true }]) + '\n```';
    const adapter = makeAdapter(fenced);

    const result = await evaluateErrors('Q?', 'resp', traps, adapter, judgeModel());

    expect(result.errorRate).toBe(1.0);
  });

  it('"triggered" value is coerced with Boolean() (truthy non-boolean → true)', async () => {
    const adapter = makeAdapter(JSON.stringify([{ trap: 'off-by-one', triggered: 'yes' }]));

    const result = await evaluateErrors('Q?', 'resp', traps, adapter, judgeModel());

    expect(result.errorRate).toBe(1.0);
  });

  it('malformed JSON → graceful degradation: errorRate 0, errorScore 1.0, onWarn fires with "parse failed"', async () => {
    const adapter = makeAdapter('{not valid json');
    const onWarn = vi.fn();

    const result = await evaluateErrors('Q?', 'resp', traps, adapter, judgeModel(), onWarn);

    expect(result).toEqual({ errorRate: 0, errorScore: 1.0, details: [] });
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]![0]).toContain('error-rate parse failed');
  });

  it('JSON response is not an array → graceful degradation via parse failure path', async () => {
    const adapter = makeAdapter(JSON.stringify({ trap: 'off-by-one', triggered: true }));
    const onWarn = vi.fn();

    const result = await evaluateErrors('Q?', 'resp', traps, adapter, judgeModel(), onWarn);

    expect(result).toEqual({ errorRate: 0, errorScore: 1.0, details: [] });
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining('error-rate parse failed'));
  });

  it('adapter.invoke rejects → graceful degradation: errorRate 0, errorScore 1.0, onWarn fires with "invoke failed"', async () => {
    const adapter = rejectingAdapter(new Error('provider timed out'));
    const onWarn = vi.fn();

    const result = await evaluateErrors('Q?', 'resp', traps, adapter, judgeModel(), onWarn);

    expect(result).toEqual({ errorRate: 0, errorScore: 1.0, details: [] });
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0]![0]).toContain('error-rate invoke failed');
    expect(onWarn.mock.calls[0]![0]).toContain('provider timed out');
  });

  it('onWarn omitted entirely → failure path does not throw', async () => {
    const adapter = rejectingAdapter(new Error('boom'));

    await expect(evaluateErrors('Q?', 'resp', traps, adapter, judgeModel())).resolves.toEqual({
      errorRate: 0,
      errorScore: 1.0,
      details: [],
    });
  });

  it('extra items beyond knownTraps.length are ignored (sliced to trap count)', async () => {
    const adapter = makeAdapter(JSON.stringify([
      { trap: 'off-by-one', triggered: false },
      { trap: 'unexpected-extra-trap', triggered: true },
    ]));

    const result = await evaluateErrors('Q?', 'resp', traps, adapter, judgeModel());

    expect(result.details).toHaveLength(1);
    expect(result.errorRate).toBe(0);
  });
});
