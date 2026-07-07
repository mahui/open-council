/**
 * Tests for the private `parseModelIds` helper in src/commands/models/add.ts
 * (P1-2 from the @info-architect review: the models/ command split left
 * mutations.ts fully tested but the add.ts pure helper with zero coverage).
 *
 * `parseModelIds` isn't exported — only `runModelsAdd` is — so it's exercised
 * two ways, both grounded in real behaviour rather than re-implementing the
 * function in the test:
 *   1. the exact split/trim/empty-drop semantics, observed via the model ids
 *      actually persisted at the end of a full `runModelsAdd()` custom-endpoint
 *      run (line 119 of add.ts: `parseModelIds(modelIdsRaw)`);
 *   2. the empty/duplicate validation semantics, observed by extracting the
 *      `validate` closure handed to @inquirer/prompts' `input()` (line 112) and
 *      calling it directly with a table of raw strings — the same technique
 *      already used for the wizard's twin implementation in
 *      test/ui/wizard/collect-custom-providers.test.ts.
 *
 * @inquirer/prompts and model-discovery are mocked (interactive/network
 * boundaries); PATHS is mocked to a per-test tmpdir so the real ConfigLoader
 * runs unmodified against disk instead of the user's actual ~/.council.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockSelect, mockInput, mockPassword, mockCheckbox, mockDiscoverModels, mockPaths } = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInput: vi.fn(),
  mockPassword: vi.fn(),
  mockCheckbox: vi.fn(),
  mockDiscoverModels: vi.fn(),
  mockPaths: {
    config: '', councilYaml: '', modelsDir: '', rolesDir: '', dataDir: '', database: '',
    sessionsDir: '', checkpoints: '', credentials: '', logs: '',
  },
}));

vi.mock('@inquirer/prompts', () => ({
  select: mockSelect,
  input: mockInput,
  password: mockPassword,
  checkbox: mockCheckbox,
}));

vi.mock('../../src/providers/model-discovery.js', () => ({
  discoverModels: mockDiscoverModels,
}));

vi.mock('../../src/config/paths.js', () => ({
  PATHS: mockPaths,
  COUNCIL_HOME: '',
}));

import { runModelsAdd } from '../../src/commands/models/add.js';
import { ConfigLoader } from '../../src/config/loader.js';

let testRoot: string;
const originalIsTTY = process.stdin.isTTY;

/** Script a full custom-endpoint run up to (and including) the model-id input;
 *  returns the `validate` closure captured from that prompt so tests can probe
 *  it directly, in addition to whatever ends up persisted to disk. */
async function runCustomEndpointAdd(modelIdsRaw: string): Promise<(v: string) => string | true> {
  mockSelect
    .mockResolvedValueOnce('custom')  // "How would you like to add a model?"
    .mockResolvedValueOnce('openai'); // wire protocol
  mockInput
    .mockResolvedValueOnce('gw')      // endpoint name
    .mockResolvedValueOnce('')        // base URL: blank → official
    .mockResolvedValueOnce(modelIdsRaw); // model identifier(s)
  mockPassword.mockResolvedValueOnce(''); // no auth

  await runModelsAdd();

  return mockInput.mock.calls[2]![0].validate as (v: string) => string | true;
}

beforeEach(() => {
  vi.clearAllMocks();
  testRoot = mkdtempSync(join(tmpdir(), 'council-models-add-'));
  Object.assign(mockPaths, {
    config: join(testRoot, 'config'),
    councilYaml: join(testRoot, 'config', 'council.yaml'),
    modelsDir: join(testRoot, 'config', 'models'),
    rolesDir: join(testRoot, 'config', 'roles'),
    dataDir: join(testRoot, 'data'),
    database: join(testRoot, 'data', 'council.db'),
    sessionsDir: join(testRoot, 'data', 'sessions'),
    checkpoints: join(testRoot, 'checkpoints'),
    credentials: join(testRoot, 'credentials'),
    logs: join(testRoot, 'logs'),
  });
  // requireConfiguredLoader() gates on existsSync(PATHS.config) — pre-create it
  // so runModelsAdd doesn't process.exit(1) as "not configured yet".
  mkdirSync(mockPaths.config, { recursive: true });
  // runModelsAdd also gates on an interactive TTY (vitest's process.stdin isn't
  // one) — force it on for the duration of the test, restored afterward.
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
});

afterEach(() => {
  Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
  rmSync(testRoot, { recursive: true, force: true });
});

describe('parseModelIds (via runModelsAdd custom-endpoint path) — split/trim/empty-drop', () => {
  it('splits on comma, trims surrounding whitespace, and drops empty segments (incl. a trailing comma)', async () => {
    await runCustomEndpointAdd('gpt-4o, llama3.2 , ,mistral,');

    const models = new ConfigLoader(mockPaths.config).loadAllModelConfigs();
    expect(models.map(m => m.model).sort()).toEqual(['gpt-4o', 'llama3.2', 'mistral'].sort());
  });

  it('a single id with no comma parses to a one-element list (surrounding whitespace trimmed)', async () => {
    await runCustomEndpointAdd('  gpt-4o  ');

    const models = new ConfigLoader(mockPaths.config).loadAllModelConfigs();
    expect(models.map(m => m.model)).toEqual(['gpt-4o']);
  });

  it('a comma-only / all-whitespace input parses to an empty list — no models are added', async () => {
    await runCustomEndpointAdd('  ,  , ');

    const models = new ConfigLoader(mockPaths.config).loadAllModelConfigs();
    expect(models).toEqual([]);
  });
});

describe('parseModelIds validation closure — empty and duplicate detection', () => {
  it('rejects an empty or whitespace/comma-only list ("At least one model id is required.")', async () => {
    const validate = await runCustomEndpointAdd('gpt-4o'); // valid run, just to capture the closure
    expect(validate('')).toContain('At least one');
    expect(validate('   ')).toContain('At least one');
    expect(validate(' , , ')).toContain('At least one');
  });

  it('rejects duplicate ids after trimming ("Duplicate model ids in input.")', async () => {
    const validate = await runCustomEndpointAdd('gpt-4o');
    expect(validate('a,a')).toContain('Duplicate');
    expect(validate('a, a ')).toContain('Duplicate'); // duplicate only after trim
  });

  it('accepts a clean, unique, non-empty list', async () => {
    const validate = await runCustomEndpointAdd('gpt-4o');
    expect(validate('a,b,c')).toBe(true);
    expect(validate('gpt-4o')).toBe(true);
  });
});
