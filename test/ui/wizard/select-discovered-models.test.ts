/**
 * Integration test for the wizard's "show all" round trip in Custom Setup
 * (src/ui/wizard/first-run.ts's private `selectDiscoveredModels`, reached via
 * `runCustomSetup` → only `runFirstRunWizard` is exported). The truncation /
 * disclosure shape of a single render is already covered by
 * `buildModelChoices` unit tests in first-run.test.ts; what's NOT covered
 * anywhere yet is the *interactive loop*: toggling the "show all" sentinel row
 * must (1) re-render the FULL list and (2) carry the user's already-ticked
 * selections into that re-render, and the final (post-reveal) selection must
 * flow all the way through to the models actually persisted to disk.
 *
 * @inquirer/prompts and model-discovery are mocked (interactive/network
 * boundaries); PATHS is mocked to a per-test tmpdir so the real ConfigLoader /
 * CredentialManager / ApiAdapter classes run unmodified against disk instead
 * of the user's real ~/.council. Connectivity testing is explicitly skipped
 * (via the mocked `confirm`) so no real ApiAdapter.invoke/network call is ever
 * made — this stays a fast, offline test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const { mockConfirm, mockSelect, mockCheckbox, mockInput, mockDiscoverModels, mockPaths } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockSelect: vi.fn(),
  mockCheckbox: vi.fn(),
  mockInput: vi.fn(),
  mockDiscoverModels: vi.fn(),
  mockPaths: {
    config: '', councilYaml: '', modelsDir: '', rolesDir: '', dataDir: '', database: '',
    sessionsDir: '', checkpoints: '', credentials: '', logs: '',
  },
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: mockConfirm,
  select: mockSelect,
  checkbox: mockCheckbox,
  input: mockInput,
  password: vi.fn(),
  Separator: class {
    separator: string;
    constructor(s = '') { this.separator = s; }
  },
}));

vi.mock('../../../src/providers/model-discovery.js', () => ({
  discoverModels: mockDiscoverModels,
  discoverEndpointModels: vi.fn(),
}));

vi.mock('../../../src/config/paths.js', () => ({
  PATHS: mockPaths,
  COUNCIL_HOME: '',
}));

import { runFirstRunWizard, buildModelChoices, SHOW_ALL_VALUE } from '../../../src/ui/wizard/first-run.js';
import type { ModelCheckboxChoice, ModelCheckboxItem } from '../../../src/ui/wizard/first-run.js';
import type { DiscoveredModel } from '../../../src/providers/model-discovery.js';

function makeDiscovered(overrides: Partial<DiscoveredModel> & { id: string }): DiscoveredModel {
  return {
    name: overrides.id,
    protocol: 'anthropic',
    source: 'official',
    ...overrides,
  };
}

/** 25 models (> the 20-item truncation threshold): 5 recommended flagships
 *  spread across both protocols + 20 non-recommended openai filler ids —
 *  mirrors the fixture in test/ui/wizard/first-run.test.ts's buildModelChoices
 *  suite so both files agree on what "truncated" looks like. */
function mixedDiscovered(): { models: DiscoveredModel[]; recommendedIds: string[]; fillerIds: string[] } {
  const recommendedIds = [
    'claude-opus-4-20250514',
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022',
    'gpt-4o',
    'gpt-5',
  ];
  const recommended = [
    makeDiscovered({ id: recommendedIds[0]!, protocol: 'anthropic' }),
    makeDiscovered({ id: recommendedIds[1]!, protocol: 'anthropic' }),
    makeDiscovered({ id: recommendedIds[2]!, protocol: 'anthropic' }),
    makeDiscovered({ id: recommendedIds[3]!, protocol: 'openai' }),
    makeDiscovered({ id: recommendedIds[4]!, protocol: 'openai' }),
  ];
  const fillerIds = Array.from({ length: 20 }, (_, i) => `filler-${String(i).padStart(2, '0')}`);
  const filler = fillerIds.map(id => makeDiscovered({ id, protocol: 'openai' }));
  return { models: [...recommended, ...filler], recommendedIds, fillerIds };
}

/** Find a choice row's key by matching the discovered id against the choice name. */
function keyFor(id: string, choices: ModelCheckboxItem[]): string {
  const row = choices
    .filter((c): c is ModelCheckboxChoice => 'value' in c)
    .find(c => c.name.startsWith(id));
  if (!row) throw new Error(`no choice row found for id ${id}`);
  return row.value;
}

let testRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  testRoot = mkdtempSync(join(tmpdir(), 'council-wizard-showall-'));
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
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('Custom Setup — "show all" checkbox round trip (selectDiscoveredModels)', () => {
  it('toggling the show-all row re-renders the FULL list with prior ticks preserved, and the post-reveal selection reaches disk', async () => {
    const { models, recommendedIds, fillerIds } = mixedDiscovered();
    mockDiscoverModels.mockResolvedValueOnce(models);

    // Reference choices (never rendered to the user; only used here to look up
    // stable checkbox `value` keys without re-deriving the private modelKey()).
    const fullChoices = buildModelChoices(models, { showAll: true }).choices;
    const recommendedKeys = recommendedIds.map(id => keyFor(id, fullChoices));
    const chosenFillerIds = [fillerIds[5]!, fillerIds[12]!];
    const chosenFillerKeys = chosenFillerIds.map(id => keyFor(id, fullChoices));

    // --- round 1: truncated view — user leaves the 5 recommended defaults
    //     ticked and additionally toggles the "show all" sentinel row. ---
    mockCheckbox.mockResolvedValueOnce([...recommendedKeys, SHOW_ALL_VALUE]);
    // --- round 2: full (revealed) view — user keeps the 5 carried-over ticks
    //     and additionally selects two filler models only visible now. ---
    mockCheckbox.mockResolvedValueOnce([...recommendedKeys, ...chosenFillerKeys]);

    mockSelect
      .mockResolvedValueOnce('custom')       // setup mode
      .mockResolvedValueOnce(recommendedIds[0]) // Chairman
      .mockResolvedValueOnce('')             // role-panel designer: auto
      .mockResolvedValueOnce('auto');        // default mode

    mockConfirm
      .mockResolvedValueOnce(true)  // skip connectivity testing (offline test — no ApiAdapter.invoke)
      .mockResolvedValueOnce(false) // decline adding a custom/standard-API endpoint
      .mockResolvedValueOnce(true); // save configuration

    mockInput
      .mockResolvedValueOnce('2') // min agents
      .mockResolvedValueOnce('7'); // max agents

    await runFirstRunWizard();

    // --- checkbox call #1: truncated view — only the 5 recommended rows + the
    //     disclosure row are offered; no filler row exists yet to pick. ---
    expect(mockCheckbox).toHaveBeenCalledTimes(2);
    const round1Choices = mockCheckbox.mock.calls[0]![0].choices as ModelCheckboxItem[];
    const round1Rows = round1Choices.filter((c): c is ModelCheckboxChoice => 'value' in c);
    expect(round1Rows.map(c => c.value)).toEqual(expect.arrayContaining([...recommendedKeys, SHOW_ALL_VALUE]));
    expect(round1Rows).toHaveLength(recommendedIds.length + 1); // 5 recommended + show-all row
    expect(round1Rows.some(c => c.value.includes('filler'))).toBe(false); // no filler row hidden view

    // --- checkbox call #2: full (revealed) view — every one of the 25 models is
    //     now a real row, the sentinel is gone, and the checked flags carried
    //     over from round 1 exactly (nothing gained, nothing lost). ---
    const round2Choices = mockCheckbox.mock.calls[1]![0].choices as ModelCheckboxItem[];
    const round2Rows = round2Choices.filter((c): c is ModelCheckboxChoice => 'value' in c);
    expect(round2Rows).toHaveLength(models.length); // all 25, no show-all sentinel
    expect(round2Rows.some(c => c.value === SHOW_ALL_VALUE)).toBe(false);
    const checkedInRound2 = new Set(round2Rows.filter(c => c.checked).map(c => c.value));
    expect(checkedInRound2).toEqual(new Set(recommendedKeys)); // exactly the carried-over ticks

    // --- the post-reveal selection (5 recommended + 2 filler) is exactly what
    //     ends up persisted to disk — proving the round trip's result actually
    //     flows through connectivity/naming/save, not just back into the loop. ---
    const savedFiles = readdirSync(mockPaths.modelsDir).filter(f => f.endsWith('.yaml'));
    expect(savedFiles.sort()).toEqual(
      [...recommendedIds, ...chosenFillerIds].map(id => `${id}.yaml`).sort(),
    );

    const council = parseYaml(readFileSync(mockPaths.councilYaml, 'utf-8')) as {
      general: { default_chairman: string };
      routing: { default: { prefer: string[] } };
    };
    expect(council.general.default_chairman).toBe(recommendedIds[0]);
    expect(council.routing.default.prefer.sort()).toEqual(
      [...recommendedIds, ...chosenFillerIds].sort(),
    );
  });
});
