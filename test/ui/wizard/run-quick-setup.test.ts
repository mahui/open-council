/**
 * Integration tests for Quick Setup (src/ui/wizard/first-run.ts's private
 * `runQuickSetup`, reached only via the exported `runFirstRunWizard` — the
 * setup-mode select routes 'quick' into it). This is the highest-risk
 * semantic in the wizard's chairman-selection wiring: `selectBestChairman` is
 * called AFTER the connectivity gate filters the candidate list, so if the
 * globally-strongest model fails its connectivity probe and the user declines
 * to keep it anyway, the persisted `default_chairman` must fall back to
 * whichever verified model is actually strongest among the *survivors* — never
 * the original (now-excluded) pick. Nothing in the existing suite drives
 * `runQuickSetup` end-to-end, so this gap was entirely unverified.
 *
 * @inquirer/prompts, model-discovery (network) and ApiAdapter (network) are
 * mocked — the three interactive/IO boundaries. PATHS is mocked to a per-test
 * tmpdir so the real ConfigLoader / CredentialManager run unmodified against
 * disk instead of the user's actual ~/.council.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const { mockConfirm, mockSelect, mockDiscoverModels, mockInvoke, mockPaths } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockSelect: vi.fn(),
  mockDiscoverModels: vi.fn(),
  mockInvoke: vi.fn(),
  mockPaths: {
    config: '', councilYaml: '', modelsDir: '', rolesDir: '', dataDir: '', database: '',
    sessionsDir: '', checkpoints: '', credentials: '', logs: '',
  },
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: mockConfirm,
  select: mockSelect,
  checkbox: vi.fn(),
  input: vi.fn(),
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

// The connectivity gate's testConnectivity() calls apiAdapter.invoke() for real
// in production; here it's swapped for a controllable stand-in so failures are
// deterministic and no network call is ever made.
vi.mock('../../../src/providers/api-adapter.js', () => ({
  ApiAdapter: vi.fn().mockImplementation(() => ({ invoke: mockInvoke })),
}));

vi.mock('../../../src/config/paths.js', () => ({
  PATHS: mockPaths,
  COUNCIL_HOME: '',
}));

import { runFirstRunWizard } from '../../../src/ui/wizard/first-run.js';
import type { DiscoveredModel } from '../../../src/providers/model-discovery.js';

function disc(id: string, protocol: DiscoveredModel['protocol'] = 'anthropic'): DiscoveredModel {
  return { id, name: id, protocol, source: 'official' };
}

let testRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  testRoot = mkdtempSync(join(tmpdir(), 'council-wizard-quick-'));
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

describe('Quick Setup — chairman selection happens AFTER the connectivity gate', () => {
  it('the globally-strongest model (opus) fails connectivity and is declined → default_chairman falls to the surviving model, and the failed model is never persisted', async () => {
    // opus: capability tier 3, flagshipRank 9 → clearly the strongest candidate.
    // gpt-4o: capability tier 2, flagshipRank 4 → the only survivor.
    mockDiscoverModels.mockResolvedValueOnce([disc('claude-opus-4-20250514', 'anthropic'), disc('gpt-4o', 'openai')]);

    mockSelect.mockResolvedValueOnce('quick'); // setup mode

    mockConfirm
      .mockResolvedValueOnce(false) // don't skip connectivity testing
      .mockResolvedValueOnce(false); // keep opus despite the failed probe? no

    mockInvoke.mockImplementation((cfg: { name: string }) =>
      cfg.name.includes('opus') ? Promise.reject(new Error('boom')) : Promise.resolve({ content: 'ok' }),
    );

    await runFirstRunWizard();

    // Both candidates were actually probed (not just the eventual chairman).
    expect(mockInvoke).toHaveBeenCalledTimes(2);

    // Only the survivor reaches disk — the dropped flagship must never be saved.
    const savedFiles = readdirSync(mockPaths.modelsDir).filter(f => f.endsWith('.yaml'));
    expect(savedFiles).toEqual(['gpt-4o.yaml']);

    const council = parseYaml(readFileSync(mockPaths.councilYaml, 'utf-8')) as {
      general: { default_chairman: string; role_generator_model: string };
    };
    expect(council.general.default_chairman).toBe('gpt-4o');
    expect(council.general.default_chairman).not.toBe('claude-opus-4-20250514');
  });

  it('every discovered model fails connectivity and all are declined → zero disk writes, setup exits before ensureDirectories/save', async () => {
    mockDiscoverModels.mockResolvedValueOnce([disc('claude-opus-4-20250514', 'anthropic'), disc('gpt-4o', 'openai')]);

    mockSelect.mockResolvedValueOnce('quick');

    mockConfirm
      .mockResolvedValueOnce(false) // don't skip
      .mockResolvedValueOnce(false) // keep model 1? no
      .mockResolvedValueOnce(false); // keep model 2? no

    mockInvoke.mockRejectedValue(new Error('boom'));

    await runFirstRunWizard();

    expect(mockInvoke).toHaveBeenCalledTimes(2); // both were still probed
    expect(existsSync(mockPaths.councilYaml)).toBe(false);
    expect(existsSync(mockPaths.config)).toBe(false); // ensureDirectories() never ran
  });
});
