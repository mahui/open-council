import { mkdirSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { select, confirm, checkbox, input, password, Separator } from '@inquirer/prompts';
import { PATHS } from '../../config/paths.js';
import { ConfigLoader } from '../../config/loader.js';
import { CredentialManager } from '../../providers/credentials/discovery.js';
import { discoverModels, discoverEndpointModels } from '../../providers/model-discovery.js';
import type { DiscoveredModel } from '../../providers/model-discovery.js';
import type { ModelConfig, Protocol } from '../../types/config.js';
import { ApiAdapter } from '../../providers/api-adapter.js';
import { rateModelCapability, isRecommendedModel } from '../../shared/model-catalog.js';
import {
  buildNamedModels,
  selectBestChairman,
  discoveredToModelConfig,
  sanitizeProviderName,
  buildCustomModelConfig,
  customCredentialPath,
} from '../../providers/model-assembly.js';
import { assembleConfig, dedupePrefer } from '../../config/assemble-council.js';

const TEST_PROMPT = 'Reply with exactly the word: ok';
const TEST_TIMEOUT_MS = 10_000;

/**
 * First-run / re-run setup wizard, collapsed to the standard-API model
 * (design-notes/standard-api-convergence.md §5): no OAuth login, no CLI binary
 * probing. Credentials are the two official env vars (ANTHROPIC_API_KEY /
 * OPENAI_API_KEY) or a 0o600 key file; models are either discovered live from
 * the official `/models` endpoint or hand-added as standard-API / custom
 * OpenAI-compatible endpoints (protocol + base_url + model id + key).
 */
export async function runFirstRunWizard(): Promise<void> {
  const loader = new ConfigLoader();

  // --- Re-run detection ---
  if (loader.isConfigured()) {
    process.stderr.write('\n\x1b[33m⚙  Council is already configured.\x1b[0m\n');
    try {
      const existingModels = loader.loadAllModels();
      const existingConfig = loader.loadCouncilConfig();
      process.stderr.write(`   Chairman : ${existingConfig.general.default_chairman}\n`);
      process.stderr.write(`   Models   : ${existingModels.map(m => m.name).join(', ')}\n`);
      process.stderr.write(`   Mode     : ${existingConfig.general.default_mode}\n\n`);
    } catch { /* partial or broken config — continue */ }

    const reconfigure = await confirm({ message: 'Reconfigure? (overwrites existing settings)' });
    if (!reconfigure) {
      process.stderr.write('Setup cancelled. Existing configuration preserved.\n');
      return;
    }
    process.stderr.write('\n');
  } else {
    process.stderr.write('\n\u{1f3db}️  Welcome to Open Council!\n');
    process.stderr.write("   Let's set up your multi-model debate system.\n\n");
  }

  const setupType = await select({
    message: 'Select setup mode:',
    choices: [
      { name: '⚡ Quick Setup (Auto-detect ANTHROPIC_API_KEY / OPENAI_API_KEY and generate a default config)', value: 'quick' },
      { name: '⚙️  Custom Setup (Interactive step-by-step configuration, incl. custom endpoints)', value: 'custom' },
    ],
  });

  if (setupType === 'quick') {
    await runQuickSetup(loader);
  } else {
    await runCustomSetup(loader);
  }
}

/** Auto-pick a balanced-tier model (by name) to design the expert panel; '' → runtime auto. */
function pickBalancedModel(configs: ModelConfig[]): string {
  return configs.find(c => rateModelCapability(c) === 2)?.name ?? '';
}

/** Clamp the agent-count range to the number of available models. */
export function clampAgents(modelCount: number): { min: number; max: number } {
  const min = modelCount >= 2 ? 2 : 1;
  const max = modelCount === 1 ? 3 : Math.min(5, modelCount);
  return { min, max: Math.max(min, max) };
}

/** A short, actionable hint for supplying a missing API key, by protocol/provider. */
export function credentialHint(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes('anthropic') || p.includes('claude')) return 'set ANTHROPIC_API_KEY';
  if (p.includes('openai') || p.includes('gpt')) return 'set OPENAI_API_KEY';
  return 'set the endpoint API key (env var or key file)';
}

/** Print the credential discovery report (env vars + custom key files). */
function printCredentialReport(report: ReturnType<CredentialManager['discoverAll']>): void {
  const entries = Object.entries(report);
  if (entries.length === 0) {
    process.stderr.write('  \x1b[2mNo API keys detected in the environment.\x1b[0m\n');
    return;
  }
  for (const [provider, result] of entries) {
    const sourceMsg =
      result.source === 'env' ? `via env var ${result.env_var ?? ''}`.trim()
      : result.path ? `via ${result.path}`
      : 'via key file';
    process.stderr.write(`  ✓ ${provider.padEnd(24)} [${result.status}] ${sourceMsg}\n`);
  }
}

async function runQuickSetup(loader: ConfigLoader): Promise<void> {
  process.stderr.write('\n⚡ Starting Quick Setup...\n');

  // --- Step 1: env credentials ---
  process.stderr.write('Step 1/3: Scanning for API keys...\n');
  const credManager = new CredentialManager();
  printCredentialReport(credManager.discoverAll());

  // --- Step 2: live model discovery (official /models endpoints) ---
  process.stderr.write('\nStep 2/3: Discovering available models...\n');
  const discovered = await discoverModels(credManager);

  let selected = discovered.filter(isRecommended);
  if (selected.length === 0) selected = discovered;

  if (selected.length === 0) {
    process.stderr.write('\n\x1b[31m⚠️  No models or API keys detected.\x1b[0m\n');
    process.stderr.write('   Quick Setup needs ANTHROPIC_API_KEY or OPENAI_API_KEY set.\n');
    process.stderr.write('   Set one of those, or use Custom Setup to add a standard-API / custom endpoint.\n\n');

    const proceedToCustom = await confirm({ message: 'Proceed with Custom Setup instead?', default: true });
    if (proceedToCustom) {
      await runCustomSetup(loader);
    } else {
      process.stderr.write('Setup exited.\n');
    }
    return;
  }

  const named = buildNamedModels(selected);
  const configs = named.map(n => n.config);

  process.stderr.write('\nEnabled models:\n');
  for (const n of named) {
    process.stderr.write(`  ✓ ${n.config.name} [${n.model.protocol}]\n`);
  }

  // --- Agent count: clamped to the number of available models ---
  const { min: minAgents, max: maxAgents } = clampAgents(named.length);
  if (named.length === 1) {
    process.stderr.write(
      '\n  \x1b[2mOnly one model available — the council will run multiple roles on the same model.\x1b[0m\n',
    );
  }

  // --- Select Chairman + panel designer ---
  const chairman = selectBestChairman(configs);
  const chairmanName = chairman?.name ?? '';
  const roleGenModel = pickBalancedModel(configs);
  process.stderr.write(`\nStep 3/3: Selected default Chairman: ${chairmanName}\n`);

  // --- Probe the chairman only (non-blocking) so a dead key surfaces now. ---
  const apiAdapter = new ApiAdapter(credManager);
  const chairmanNamed = named.find(n => n.config.name === chairmanName);
  if (chairmanNamed) {
    const { ok, error } = await testConnectivity(chairmanNamed.config, apiAdapter);
    if (!ok) {
      process.stderr.write(
        `\n  \x1b[33m⚠  Chairman probe failed: ${error ?? 'unknown error'}.\n` +
        `     Config will still be written — verify credentials, then run "council models check".\x1b[0m\n`,
      );
    }
  }

  ensureDirectories();

  // Quick never wipes existing models — upsert the discovered ones.
  for (const n of named) loader.saveModelConfig(n.config);

  const base = loader.loadCouncilConfigSafe();
  const config = assembleConfig({
    generalOverride: {
      default_chairman: chairmanName,
      role_generator_model: roleGenModel,
      min_agents: minAgents,
      max_agents: maxAgents,
    },
    prefer: dedupePrefer(configs.map(c => c.name)),
    chairman: chairmanName,
    base,
  });

  loader.saveCouncilConfig(config);

  process.stderr.write('\n\x1b[32m⚡ Quick Setup complete!\x1b[0m\n');
  process.stderr.write(`   Config : ${PATHS.councilYaml}\n`);
  process.stderr.write(`   Models : ${PATHS.modelsDir}\n\n`);
  process.stderr.write('   Run "council <question>" to start your first debate!\n\n');
}

async function runCustomSetup(loader: ConfigLoader): Promise<void> {
  // --- Step 1: Credential scan ---
  process.stderr.write('Step 1/5: Scanning for API keys...\n');
  const credManager = new CredentialManager();
  printCredentialReport(credManager.discoverAll());

  const apiAdapter = new ApiAdapter(credManager);
  let finalSelected: DiscoveredModel[] = [];

  // --- Step 2: Discover official models from any detected env keys ---
  process.stderr.write('\nStep 2/5: Discovering available models...\n');
  const discovered = await discoverModels(credManager);

  if (discovered.length === 0) {
    process.stderr.write('\n⚠  No models found from detected API keys.\n');
    process.stderr.write('  Continuing — you can still add standard-API / custom endpoints next.\n');
  } else {
    const selected = await selectDiscoveredModels(discovered);

    if (selected.length > 0) {
      const wantTest = await confirm({
        message: 'Test model connectivity? (short API calls to verify credentials, ~5-10s)',
        default: false,
      });

      if (wantTest) {
        process.stderr.write('\nStep 3/5: Testing model connectivity...\n');
        const testResults = await Promise.all(
          selected.map(async m => {
            const modelConfig = discoveredToModelConfig(m);
            const { ok, error } = await testConnectivity(modelConfig, apiAdapter);
            const icon = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
            const suffix = ok ? '\x1b[32mready\x1b[0m' : `\x1b[31mFAILED\x1b[0m — ${error ?? 'unknown error'}`;
            process.stderr.write(`  ${icon} ${m.name.padEnd(44)} ${suffix}\n`);
            return { model: m, ok };
          }),
        );

        const failed = testResults.filter(r => !r.ok);
        finalSelected = selected;
        if (failed.length > 0) {
          process.stderr.write(`\n  \x1b[33m${failed.length} model(s) failed connectivity test.\x1b[0m\n`);
          const keepFailed = await confirm({ message: 'Keep failed models in configuration anyway?', default: false });
          if (!keepFailed) {
            finalSelected = selected.filter(m => testResults.find(r => r.model === m)?.ok);
          }
        }
      } else {
        finalSelected = selected;
      }
    }
  }

  // --- Step 2b: Custom / standard-API endpoints (always offered) ---
  const customConfigs = await collectCustomProviders(apiAdapter);

  if (finalSelected.length === 0 && customConfigs.length === 0) {
    process.stderr.write('No models configured. Exiting setup.\n');
    return;
  }

  // Resolve collision-free names once; chairman/role-generator/prefer all reference them.
  const named = buildNamedModels(finalSelected);

  // --- Step 4: Chairman ---
  process.stderr.write('\nStep 4/5: Choose Chairman (synthesizes debate results)\n');
  const chairmanChoices = [
    ...named.map(n => ({ name: `${n.config.name} [${n.model.protocol}]`, value: n.config.name })),
    ...customConfigs.map(c => ({ name: `${c.name} [${c.protocol}, custom]`, value: c.name })),
  ];
  const chairmanId = await select({
    message: 'Chairman model:',
    choices: chairmanChoices,
  });

  // --- Role panel designer (optional) ---
  const roleGenModel = await select({
    message: 'Model to design the expert panel (role generator):',
    choices: [
      { name: 'Auto (pick a balanced model at runtime)', value: '' },
      ...named.map(n => ({ name: n.config.name, value: n.config.name })),
      ...customConfigs.map(c => ({ name: c.name, value: c.name })),
    ],
    default: '',
  });

  // --- Step 5: Default mode ---
  process.stderr.write('\nStep 5/5: Default debate mode\n');
  const defaultMode = await select({
    message: 'Default mode:',
    choices: [
      { name: 'auto    — pick mode by question complexity (recommended)', value: 'auto' },
      { name: 'compare — parallel responses + synthesis', value: 'compare' },
      { name: 'debate  — full debate with peer review rounds', value: 'debate' },
      { name: 'quick   — single model, fastest response', value: 'quick' },
    ],
  }) as 'auto' | 'compare' | 'debate' | 'quick';

  // --- Agent count range ---
  const modelCount = named.length + customConfigs.length;
  const minAgents = Number(await input({
    message: 'Minimum number of agents:',
    default: String(modelCount >= 2 ? 2 : 1),
    validate: (v: string) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 ? true : 'Enter a positive integer.'),
  }));
  const maxAgents = Number(await input({
    message: 'Maximum number of agents:',
    default: String(Math.max(minAgents, 5)),
    validate: (v: string) => {
      if (!/^\d+$/.test(v.trim())) return 'Enter a positive integer.';
      if (Number(v) < minAgents) return `Must be >= minimum (${minAgents}).`;
      return true;
    },
  }));

  const confirmed = await confirm({ message: 'Save configuration?' });
  if (!confirmed) {
    // Clean up orphan key files — config was never saved, so the references are dead.
    for (const c of customConfigs) {
      if (c.api_key_path) {
        try { unlinkSync(c.api_key_path); } catch { /* already gone */ }
      }
    }
    process.stderr.write('Setup cancelled.\n');
    return;
  }

  // Decide how to reconcile with any pre-existing model set (default: keep & merge).
  let replaceAll = false;
  if (loader.hasModelConfigs()) {
    const strategy = await select({
      message: 'Existing model configuration detected — how should it be handled?',
      choices: [
        { name: 'Keep & merge (upsert selected models, preserve the rest)', value: 'merge' },
        { name: 'Replace all (delete existing model configs first)', value: 'replace' },
      ],
      default: 'merge',
    });
    replaceAll = strategy === 'replace';
  }

  ensureDirectories();

  if (replaceAll) loader.clearAllModels();

  for (const n of named) loader.saveModelConfig(n.config);
  for (const c of customConfigs) loader.saveModelConfig(c);

  const chairmanName = chairmanId
    ?? named[0]?.config.name
    ?? customConfigs[0]?.name
    ?? '';
  const preferIds = dedupePrefer([...named.map(n => n.config.name), ...customConfigs.map(c => c.name)]);

  const base = replaceAll ? null : loader.loadCouncilConfigSafe();
  const config = assembleConfig({
    generalOverride: {
      default_mode: defaultMode,
      default_chairman: chairmanName,
      role_generator_model: roleGenModel,
      min_agents: minAgents,
      max_agents: maxAgents,
    },
    prefer: preferIds,
    chairman: chairmanName,
    base,
  });

  loader.saveCouncilConfig(config);

  process.stderr.write('\n✅ Configuration saved!\n');
  process.stderr.write(`   Config : ${PATHS.councilYaml}\n`);
  process.stderr.write(`   Models : ${PATHS.modelsDir}\n\n`);
  process.stderr.write('   Run "council <question>" to start your first debate!\n\n');
}

// ---------- helpers ----------

/** Create the on-disk directory skeleton the config system writes into. */
function ensureDirectories(): void {
  mkdirSync(PATHS.config, { recursive: true });
  mkdirSync(PATHS.modelsDir, { recursive: true });
  mkdirSync(PATHS.dataDir, { recursive: true });
  mkdirSync(PATHS.sessionsDir, { recursive: true });
  mkdirSync(PATHS.checkpoints, { recursive: true });
  mkdirSync(PATHS.logs, { recursive: true });
}

function modelKey(m: DiscoveredModel): string {
  return `${m.protocol}:${m.id}:${m.base_url ?? 'official'}`;
}

/**
 * Does this model look like a flagship/recommended debate participant?
 *
 * Delegates to the shared MODEL_TIER_RULES table (src/shared/model-catalog.ts)
 * so the wizard's default-participant heuristic never drifts from chairman
 * ranking — the recommendation vocabulary (mini/nano/lite exclusions, o4
 * inclusion, etc.) lives in exactly one place.
 */
export function isRecommended(m: DiscoveredModel): boolean {
  return isRecommendedModel(m.id);
}

export type ModelCheckboxChoice = { name: string; value: string; checked: boolean };
export type ModelCheckboxItem = ModelCheckboxChoice | Separator;

export interface BuildModelChoicesOptions {
  /** Render the complete list without per-protocol truncation. */
  showAll?: boolean;
  /**
   * When provided, each choice's `checked` state is read from this set (by model
   * key) instead of the `isRecommended` default. Used to carry the user's current
   * selections across a "show all" re-render.
   */
  checkedKeys?: ReadonlySet<string>;
}

export interface ModelChoicesResult {
  choices: ModelCheckboxItem[];
  /** Number of models hidden by truncation (0 when the full list is shown). */
  hiddenCount: number;
}

/** Above this many discovered models the default view collapses to the flagships. */
const MODEL_LIST_TRUNCATE_THRESHOLD = 20;
/** Sentinel checkbox value: toggling it re-renders the full, untruncated list. */
export const SHOW_ALL_VALUE = '__council_show_all__';

/**
 * Shape the discovered models into checkbox choices. When the list is long the
 * default view collapses to the recommended flagships per protocol, but — unlike
 * the previous silent truncation — the hidden models are disclosed via the
 * per-protocol header ("showing N of M") and an actionable "show all" row, so
 * the user always knows nothing was quietly dropped.
 */
export function buildModelChoices(
  discovered: DiscoveredModel[],
  options: BuildModelChoicesOptions = {},
): ModelChoicesResult {
  const { showAll = false, checkedKeys } = options;
  const truncate = !showAll && discovered.length > MODEL_LIST_TRUNCATE_THRESHOLD;

  const byProtocol = new Map<Protocol, DiscoveredModel[]>();
  for (const m of discovered) {
    const list = byProtocol.get(m.protocol) ?? [];
    list.push(m);
    byProtocol.set(m.protocol, list);
  }

  const isChecked = (m: DiscoveredModel): boolean =>
    checkedKeys ? checkedKeys.has(modelKey(m)) : isRecommended(m);

  const choices: ModelCheckboxItem[] = [];
  let hiddenCount = 0;

  for (const [protocol, models] of byProtocol) {
    const sorted = [...models].sort((a, b) => {
      const ra = isRecommended(a) ? 0 : 1;
      const rb = isRecommended(b) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });

    // Default (truncated) view surfaces only the recommended flagships; the rest
    // stay one keystroke away behind the "show all" row rather than being dropped.
    const visible = truncate ? sorted.filter(isRecommended) : sorted;
    const hiddenHere = sorted.length - visible.length;
    hiddenCount += hiddenHere;

    choices.push(new Separator(
      hiddenHere > 0 ? `── ${protocol} (showing ${visible.length} of ${sorted.length}) ──` : `── ${protocol} ──`,
    ));

    for (const m of visible) {
      choices.push({
        name: `${m.name}  [${m.protocol}]`,
        value: modelKey(m),
        checked: isChecked(m),
      });
    }
  }

  // Explicit, actionable disclosure of what truncation hid — toggling this row
  // re-renders the complete list instead of silently dropping the rest.
  if (hiddenCount > 0) {
    choices.push(new Separator(' '));
    choices.push({
      name: `⋯ Show all ${discovered.length} models  (${hiddenCount} more hidden — toggle to reveal)`,
      value: SHOW_ALL_VALUE,
      checked: false,
    });
  }

  return { choices, hiddenCount };
}

/**
 * Present the discovered models as a checkbox list, disclosing (never hiding)
 * any truncation. When the list is long it is capped per protocol with a
 * "N more hidden" action row; toggling that row re-renders the full list with
 * the user's current selections preserved.
 */
async function selectDiscoveredModels(discovered: DiscoveredModel[]): Promise<DiscoveredModel[]> {
  let showAll = false;
  let checkedKeys: ReadonlySet<string> | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { choices } = buildModelChoices(discovered, { showAll, checkedKeys });
    process.stderr.write('\n');
    const selectedKeys = await checkbox({
      message: 'Choose models for your council (space to toggle, leave empty to skip):',
      choices,
      pageSize: 18,
    });

    if (selectedKeys.includes(SHOW_ALL_VALUE)) {
      // Reveal the full list, carrying over whatever the user had already ticked.
      showAll = true;
      checkedKeys = new Set(selectedKeys.filter(k => k !== SHOW_ALL_VALUE));
      process.stderr.write('  Showing the full model list…\n');
      continue;
    }

    return selectedKeys
      .map(k => discovered.find(m => modelKey(m) === k))
      .filter((m): m is DiscoveredModel => !!m);
  }
}

/** Make a short (~10s) real API call to verify a model's credentials work. */
async function testConnectivity(
  modelConfig: ModelConfig,
  apiAdapter: ApiAdapter,
): Promise<{ ok: boolean; error?: string }> {
  const testConfig: ModelConfig = { ...modelConfig, timeout_seconds: 12 };
  try {
    await Promise.race([
      apiAdapter.invoke(testConfig, TEST_PROMPT),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('timeout after 10s')), TEST_TIMEOUT_MS),
      ),
    ]);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.length > 80 ? msg.substring(0, 80) + '…' : msg };
  }
}

// ---------- standard-API / custom OpenAI-compatible endpoints ----------

/**
 * Interactively collect standard-API models: pick a protocol, a base_url
 * (default official, editable → any compatible endpoint), an optional API key
 * (pasted → 0o600 key file, or left empty for no-auth localhost endpoints), and
 * one or more model ids — either discovered live from the endpoint's `/models`
 * list (checkbox-select) or typed by hand. Covers both "official model, manual
 * key" and "custom gateway / self-hosted" cases.
 */
async function collectCustomProviders(apiAdapter: ApiAdapter): Promise<ModelConfig[]> {
  const wantCustom = await confirm({
    message: 'Add a standard-API / custom endpoint? (Anthropic, OpenAI, ollama, vLLM, LM Studio, gateways…)',
    default: false,
  });
  if (!wantCustom) return [];

  const collected: ModelConfig[] = [];
  const usedNames = new Set<string>();
  process.stderr.write('\n');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rawName = await input({
      message: 'Endpoint name (lowercase, a-z 0-9 -):',
      validate: (v: string) => {
        const s = sanitizeProviderName(v);
        if (!s) return 'Name must contain at least one letter or digit.';
        if (usedNames.has(s)) return `Endpoint '${s}' already added in this session.`;
        return true;
      },
    });
    const sanitizedName = sanitizeProviderName(rawName);

    const protocol = await select<Protocol>({
      message: 'Wire protocol (which SDK the endpoint speaks):',
      choices: [
        { name: 'openai    — OpenAI & compatible (DeepSeek, Moonshot, ollama, vLLM…)', value: 'openai' },
        { name: 'anthropic — Anthropic & compatible', value: 'anthropic' },
      ],
      default: 'openai',
    });

    const baseUrl = await input({
      message: 'Base URL (blank → official endpoint; e.g. http://localhost:11434/v1):',
      validate: (v: string) => {
        if (v.trim() === '') return true;
        try {
          const u = new URL(v);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'URL must use http or https.';
          return true;
        } catch {
          return 'Invalid URL.';
        }
      },
    });

    // Key is captured before model ids so the discovery path can authenticate
    // against the endpoint; it is only written to disk once we keep a model.
    const apiKey = await password({
      message: 'API key (leave empty for no auth, e.g. local ollama):',
      mask: '*',
    });

    // Empty base_url → official endpoint; buildCustomModelConfig always sets
    // base_url, so an official standard-API model just carries the official URL,
    // which resolves the same as omitting it.
    const resolvedBaseUrl = baseUrl.trim() || officialBaseUrl(protocol);

    const modelIds = await resolveEndpointModelIds({
      protocol,
      baseUrl: resolvedBaseUrl,
      apiKey,
      sourceLabel: sanitizedName,
    });

    if (modelIds.length === 0) {
      process.stderr.write('  No models chosen for this endpoint — skipping it.\n');
      const more = await confirm({ message: 'Add another endpoint?', default: false });
      if (!more) break;
      continue;
    }

    // Persist key once per endpoint — all models this round share the credential file.
    let credPath: string | undefined;
    if (apiKey.length > 0) {
      mkdirSync(PATHS.credentials, { recursive: true, mode: 0o700 });
      credPath = customCredentialPath(sanitizedName);
      writeFileSync(credPath, apiKey);
      chmodSync(credPath, 0o600);
    }

    let anyKept = false;
    for (const modelId of modelIds) {
      const cfg = buildCustomModelConfig({
        sanitizedName,
        modelId,
        baseUrl: resolvedBaseUrl,
        protocol,
        ...(credPath ? { credentialPath: credPath } : {}),
      });

      process.stderr.write(`  Testing ${cfg.name}...\n`);
      const { ok, error } = await testConnectivity(cfg, apiAdapter);
      if (ok) {
        process.stderr.write(`  \x1b[32m✓\x1b[0m ${cfg.name} ready\n`);
        collected.push(cfg);
        anyKept = true;
      } else {
        process.stderr.write(`  \x1b[31m✗\x1b[0m ${cfg.name} FAILED — ${error ?? 'unknown error'}\n`);
        const keep = await confirm({ message: `Keep ${modelId} in configuration anyway?`, default: false });
        if (keep) {
          collected.push(cfg);
          anyKept = true;
        }
      }
    }

    if (anyKept) usedNames.add(sanitizedName);
    else if (credPath) {
      try { unlinkSync(credPath); } catch { /* already gone */ }
    }

    const more = await confirm({ message: 'Add another endpoint?', default: false });
    if (!more) break;
  }

  return collected;
}

/** Official base URL for a protocol (mirrors OFFICIAL_BASE_URL in the schema). */
function officialBaseUrl(protocol: Protocol): string {
  return protocol === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
}

/**
 * Obtain the model ids for a custom endpoint. The user picks between discovering
 * them live from the endpoint's `/models` list (checkbox-select) and typing them
 * by hand. Discovery is best-effort: `discoverEndpointModels` returns [] (never
 * throws) on failure/timeout, in which case we note it on stderr and degrade to
 * the manual path rather than showing an empty checkbox. An empty selection from
 * a populated list is treated as "skip this endpoint" (returns []).
 */
export async function resolveEndpointModelIds(opts: {
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  sourceLabel: string;
}): Promise<string[]> {
  const method = await select<'discover' | 'manual'>({
    message: 'How should this endpoint\'s models be chosen?',
    choices: [
      { name: 'Discover from the endpoint (query its /models list)', value: 'discover' },
      { name: 'Enter model id(s) manually (comma-separated)', value: 'manual' },
    ],
    default: 'discover',
  });

  if (method === 'discover') {
    process.stderr.write('  Discovering models from the endpoint…\n');
    const discovered = await discoverEndpointModels({
      protocol: opts.protocol,
      baseUrl: opts.baseUrl,
      ...(opts.apiKey.length > 0 ? { apiKey: opts.apiKey } : {}),
      sourceLabel: opts.sourceLabel,
    });

    if (discovered.length > 0) {
      // A populated list — selection (possibly empty) is authoritative.
      return selectEndpointModelIds(discovered);
    }
    process.stderr.write(
      '  \x1b[33mEndpoint returned no model list — enter id(s) manually instead.\x1b[0m\n',
    );
    // fall through to the manual prompt
  }

  return promptManualModelIds();
}

/** Checkbox-select model ids from a live-discovered endpoint list. */
async function selectEndpointModelIds(discovered: DiscoveredModel[]): Promise<string[]> {
  process.stderr.write('\n');
  return checkbox({
    message: `Select models from this endpoint (${discovered.length} found; space to toggle, empty to skip):`,
    choices: discovered.map(m => ({ name: m.id, value: m.id, checked: false })),
    pageSize: 18,
  });
}

/** Prompt for a comma-separated model id list (manual fallback / explicit choice). */
async function promptManualModelIds(): Promise<string[]> {
  const raw = await input({
    message: 'Model identifier(s) — comma-separated (e.g. gpt-4o or llama3.2,mistral):',
    validate: (v: string) => {
      const ids = parseModelIds(v);
      if (ids.length === 0) return 'At least one model id is required.';
      if (new Set(ids).size !== ids.length) return 'Duplicate model ids in input.';
      return true;
    },
  });
  return parseModelIds(raw);
}

/** Parse a comma-separated model id list, trimming and dropping empties. */
function parseModelIds(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
}
