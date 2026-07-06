/**
 * End-to-end test for Custom Setup's standard-API / custom-endpoint path
 * (src/ui/wizard/first-run.ts's private `collectCustomProviders` +
 * `resolveEndpointModelIds`, reached only via the exported
 * `runFirstRunWizard`). Unlike test/ui/wizard/collect-custom-providers.test.ts
 * (which drives `resolveEndpointModelIds` directly in isolation) and
 * test/ui/wizard/select-discovered-models.test.ts (which covers the
 * *discovered-official-models* branch of Custom Setup), nothing previously
 * exercised the "no official models discovered, add a hand-typed custom
 * endpoint instead" branch all the way through to disk — including the
 * 0o600 credential key file and the wizard's own schema-validating
 * `ConfigLoader` reload.
 *
 * @inquirer/prompts and model-discovery are mocked (the interactive/network
 * boundaries — discovery returns [] so the wizard falls through to the manual
 * custom-endpoint path). PATHS is mocked to a per-test tmpdir. Connectivity
 * testing is explicitly skipped via the mocked `confirm`, so the real
 * (unmocked) ApiAdapter's `invoke` is never called — zero network, offline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockConfirm, mockSelect, mockInput, mockPassword, mockDiscoverModels, mockPaths } = vi.hoisted(() => ({
  mockConfirm: vi.fn(),
  mockSelect: vi.fn(),
  mockInput: vi.fn(),
  mockPassword: vi.fn(),
  mockDiscoverModels: vi.fn(),
  mockPaths: {
    config: '', councilYaml: '', modelsDir: '', rolesDir: '', dataDir: '', database: '',
    sessionsDir: '', checkpoints: '', credentials: '', logs: '',
  },
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: mockConfirm,
  select: mockSelect,
  checkbox: vi.fn(),
  input: mockInput,
  password: mockPassword,
  Separator: class {
    separator: string;
    constructor(s = '') { this.separator = s; }
  },
}));

vi.mock('../../src/providers/model-discovery.js', () => ({
  discoverModels: mockDiscoverModels,
  discoverEndpointModels: vi.fn(),
}));

vi.mock('../../src/config/paths.js', () => ({
  PATHS: mockPaths,
  COUNCIL_HOME: '',
}));

import { runFirstRunWizard } from '../../src/ui/wizard/first-run.js';
import { ConfigLoader } from '../../src/config/loader.js';

let testRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  testRoot = mkdtempSync(join(tmpdir(), 'council-wizard-custom-e2e-'));
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
  mockDiscoverModels.mockResolvedValue([]); // no official API keys detected
});

afterEach(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe('Custom Setup e2e — hand-typed custom endpoint (no discovered official models)', () => {
  it('collects a manually-typed model list for a custom endpoint, persists the key + models + council.yaml, and a FRESH ConfigLoader reloads it all schema-clean', async () => {
    mockSelect
      .mockResolvedValueOnce('custom')                    // setup mode
      .mockResolvedValueOnce('openai')                     // wire protocol
      .mockResolvedValueOnce('manual')                     // resolveEndpointModelIds: manual entry
      .mockResolvedValueOnce('custom:mylab:llama3.2')       // Chairman model
      .mockResolvedValueOnce('')                            // role-panel designer: auto
      .mockResolvedValueOnce('auto');                       // default mode

    mockConfirm
      .mockResolvedValueOnce(true)   // add a standard-API / custom endpoint? yes
      .mockResolvedValueOnce(true)   // skip connectivity testing (offline test)
      .mockResolvedValueOnce(false)  // add another endpoint? no
      .mockResolvedValueOnce(true);  // save configuration? yes

    mockInput
      .mockResolvedValueOnce('mylab')                       // endpoint name
      .mockResolvedValueOnce('http://localhost:11434/v1')   // base URL (custom, non-official)
      .mockResolvedValueOnce('llama3.2,mistral')            // manual model id list
      .mockResolvedValueOnce('2')                           // min agents
      .mockResolvedValueOnce('5');                          // max agents

    mockPassword.mockResolvedValueOnce('sk-test-manual');   // endpoint API key

    await runFirstRunWizard();

    // --- credential key file: 0o600, correct content, correct path scheme ---
    const keyPath = join(mockPaths.credentials, 'custom-mylab.key');
    expect(readFileSync(keyPath, 'utf-8')).toBe('sk-test-manual');
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);

    // --- both manually-entered models persisted, named via the custom scheme ---
    const savedFiles = readdirSync(mockPaths.modelsDir).filter(f => f.endsWith('.yaml'));
    expect(savedFiles.sort()).toEqual(['custom:mylab:llama3.2.yaml', 'custom:mylab:mistral.yaml'].sort());

    // --- the real, schema-validating ConfigLoader (a FRESH instance) reloads
    //     the wizard's output cleanly — proves the persisted YAML round-trips
    //     through CouncilConfigSchema/ModelConfigSchema, not just "parses". ---
    const reloadedLoader = new ConfigLoader(mockPaths.config);
    const council = reloadedLoader.loadCouncilConfig(); // throws on schema violation
    expect(council.general.default_chairman).toBe('custom:mylab:llama3.2');
    expect(council.routing.default.prefer.slice().sort()).toEqual(
      ['custom:mylab:llama3.2', 'custom:mylab:mistral'].sort(),
    );

    const models = reloadedLoader.loadAllModels(); // schema-validates each model file
    expect(models.map(m => m.name).sort()).toEqual(['custom:mylab:llama3.2', 'custom:mylab:mistral'].sort());
    const llama = models.find(m => m.name === 'custom:mylab:llama3.2')!;
    expect(llama.protocol).toBe('openai');
    expect(llama.model).toBe('llama3.2');
    expect(llama.base_url).toBe('http://localhost:11434/v1');
    expect(llama.api_key_path).toBe(keyPath);
    expect(llama.enabled).toBe(true);
  });
});
