import { mkdirSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { select, confirm, checkbox, input, password, Separator } from '@inquirer/prompts';
import { PATHS } from '../../config/paths.js';
import { ConfigLoader } from '../../config/loader.js';
import { CredentialManager } from '../../providers/credentials/discovery.js';
import { discoverModels } from '../../providers/model-discovery.js';
import type { DiscoveredModel } from '../../providers/model-discovery.js';
import type { ModelConfig } from '../../types/config.js';
import { ApiAdapter } from '../../providers/api-adapter.js';
import { rateModelCapability } from '../../core/role-generator.js';
import {
  buildNamedModels,
  selectBestChairman,
  discoveredToModelConfig,
  sanitizeProviderName,
  buildCustomModelConfig,
  customCredentialPath,
} from '../../providers/model-assembly.js';
import { assembleConfig } from '../../config/assemble-council.js';
import { hasBinary } from '../../shared/env.js';

const TEST_PROMPT = "Reply with exactly the word: ok";
const TEST_TIMEOUT_MS = 10_000;

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
    process.stderr.write('\n\u{1f3db}\ufe0f  Welcome to Open Council!\n');
    process.stderr.write("   Let's set up your multi-model debate system.\n\n");
  }

  const setupType = await select({
    message: 'Select setup mode:',
    choices: [
      { name: '⚡ Quick Setup (Auto-detect credentials and generate default config in 1s)', value: 'quick' },
      { name: '⚙️  Custom Setup (Interactive step-by-step configuration)', value: 'custom' },
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

/** Human-facing provider labels; internal pi-ai ids are kept as option values. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  'anthropic': 'Anthropic (Claude)',
  'openai': 'OpenAI',
  'openai-codex': 'OpenAI (Codex CLI)',
  'google': 'Google (Gemini)',
  'google-gemini-cli': 'Google Gemini CLI',
  'google-antigravity': 'Google Antigravity',
  'google-vertex': 'Google Vertex AI',
  'github-copilot': 'GitHub Copilot',
};

function providerDisplayName(id: string): string {
  return PROVIDER_DISPLAY_NAMES[id] ?? id;
}

/** A short, actionable hint for refreshing a broken credential, by provider. */
export function credentialHint(provider: string): string {
  const p = provider.toLowerCase();
  if (p.includes('anthropic') || p.includes('claude')) return 'run `claude login` to refresh';
  if (p.includes('codex') || p.includes('openai')) return 'run `codex login` to refresh';
  if (p.includes('gemini') || p.includes('google')) return 'run `gemini` and sign in to refresh';
  if (p.includes('copilot') || p.includes('github')) return 'run `gh auth login` to refresh';
  return 'check the credential file';
}

async function runQuickSetup(loader: ConfigLoader): Promise<void> {
  process.stderr.write('\n⚡ Starting Quick Setup...\n');

  // --- Scan credentials ---
  process.stderr.write('Step 1/3: Scanning for AI credentials...\n');
  const credManager = new CredentialManager();
  const report = await credManager.discoverAll();

  for (const [provider, result] of Object.entries(report)) {
    const isOk = result.status === 'valid' || result.status === 'refreshed';
    const statusMsg = `[${result.status}]`.padEnd(12);
    if (isOk) {
      const sourceMsg =
        result.source === 'env' ? 'via env var'
        : result.path ? `via ${result.path}`
        : 'via file';
      process.stderr.write(`  ✓ ${provider.padEnd(24)} ${statusMsg} ${sourceMsg}\n`);
    } else {
      // Surface broken credentials instead of hiding them — a silent skip here is
      // exactly how expired/unparseable creds slip into the config unnoticed.
      process.stderr.write(
        `  \x1b[31m✗\x1b[0m ${provider.padEnd(24)} ${statusMsg} \x1b[2m${credentialHint(provider)}\x1b[0m\n`,
      );
    }
  }

  // --- Discover models ---
  process.stderr.write('\nStep 2/3: Discovering available models...\n');
  const discovered = await discoverModels(credManager);

  let selected = discovered.filter(isRecommended);
  if (selected.length === 0) {
    // If no recommended models, fall back to any discovered models
    selected = discovered;
  }

  if (selected.length === 0) {
    process.stderr.write('\n\x1b[31m⚠️  No models or credentials detected.\x1b[0m\n');
    process.stderr.write('   Quick Setup cannot continue without credentials.\n');
    process.stderr.write('   Please set environment variables (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY)\n');
    process.stderr.write('   or proceed with Custom Setup to configure custom endpoints.\n\n');

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
    process.stderr.write(`  ✓ ${n.config.name} [${n.model.invocation}]\n`);
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

  // --- Probe the chairman only (non-blocking): fast smoke test so a dead
  //     credential surfaces now instead of on the first real debate. ---
  const apiAdapter = new ApiAdapter(credManager);
  const chairmanNamed = named.find(n => n.config.name === chairmanName);
  if (chairmanNamed) {
    const { ok, error } = await testConnectivity(chairmanNamed.model, chairmanNamed.config, apiAdapter);
    if (!ok) {
      process.stderr.write(
        `\n  \x1b[33m⚠  Chairman probe failed: ${error ?? 'unknown error'}.\n` +
        `     Config will still be written — verify credentials, then run "council models test".\x1b[0m\n`,
      );
    }
  }

  // Create required directories
  mkdirSync(PATHS.config, { recursive: true });
  mkdirSync(PATHS.modelsDir, { recursive: true });
  mkdirSync(PATHS.dataDir, { recursive: true });
  mkdirSync(PATHS.sessionsDir, { recursive: true });
  mkdirSync(PATHS.checkpoints, { recursive: true });
  mkdirSync(PATHS.logs, { recursive: true });

  // Quick never wipes existing models — upsert the discovered ones onto whatever
  // the user already has, preserving any hand-tuned model files.
  for (const n of named) {
    loader.saveModelConfig(n.config);
  }

  // Merge onto the existing council.yaml when present: only the wizard-decided
  // fields (chairman / prefer / role generator / agent counts) are overwritten.
  const base = loader.loadCouncilConfigSafe();
  const config = assembleConfig({
    generalOverride: {
      default_chairman: chairmanName,
      role_generator_model: roleGenModel,
      min_agents: minAgents,
      max_agents: maxAgents,
    },
    prefer: configs.map(c => c.name),
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
  process.stderr.write('Step 1/5: Scanning for AI credentials...\n');
  const credManager = new CredentialManager();
  const report = await credManager.discoverAll();

  for (const [provider, result] of Object.entries(report)) {
    const isOk = result.status === 'valid' || result.status === 'refreshed';
    const icon = isOk ? '\u2713' : '\u2717';
    const statusMsg = `[${result.status}]`.padEnd(12);
    const sourceMsg =
      result.source === 'env' ? 'via env var'
      : result.path ? `via ${result.path}`
      : 'via file';
    process.stderr.write(`  ${icon} ${provider.padEnd(24)} ${statusMsg} ${sourceMsg}\n`);
  }

  // Offer OAuth login for providers without credentials
  const loginable = credManager.getLoginableProviders();
  const missingProviders = loginable.filter(p => !credManager.hasCredential(p.id));
  if (missingProviders.length > 0) {
    process.stderr.write('\n  Providers that support OAuth login:\n');
    for (const p of missingProviders) process.stderr.write(`    - ${p.name}\n`);
    const wantLogin = await confirm({
      message: 'Add new OAuth logins?  (existing credentials will be used regardless)',
      default: false,
    });
    if (wantLogin) await runOAuthLogins(credManager, missingProviders);
  }

  // --- Step 1.5: Filter providers (let user opt out of detected ones) ---
  // Empty selection is meaningful here: user wants to skip auto-detected providers
  // entirely and configure custom key-based providers in Step 2b instead.
  const detectedProviders = credManager.getAvailableProviders();
  let enabledProviders: Set<string> | undefined;
  let skipAutoDiscovery = false;
  if (detectedProviders.length > 0) {
    process.stderr.write('\n');
    const kept = await checkbox({
      message: 'Enable which detected providers? (uncheck all to skip and use only custom providers):',
      choices: detectedProviders.map(p => ({ name: providerDisplayName(p), value: p, checked: true })),
      pageSize: 12,
    });
    enabledProviders = new Set(kept);
    skipAutoDiscovery = kept.length === 0;
    if (skipAutoDiscovery) {
      process.stderr.write('  \x1b[2mSkipping auto-discovery — you will configure custom providers next.\x1b[0m\n');
    }
  }

  const apiAdapter = new ApiAdapter(credManager);
  let finalSelected: DiscoveredModel[] = [];

  if (!skipAutoDiscovery) {
    // --- Step 2: Discover models ---
    process.stderr.write('\nStep 2/5: Discovering available models...\n');
    const discovered = await discoverModels(credManager, enabledProviders);

    if (discovered.length === 0) {
      process.stderr.write('\n\u26a0  No models found from detected credentials.\n');
      process.stderr.write('  Continuing — you can still add custom Key-based providers next.\n');
    } else {
      // Summary by provider
      const byProvider = new Map<string, DiscoveredModel[]>();
      for (const m of discovered) {
        const list = byProvider.get(m.provider) ?? [];
        list.push(m);
        byProvider.set(m.provider, list);
      }
      for (const [provider, models] of byProvider) {
        process.stderr.write(`  ${provider}: ${models.length} model(s) available\n`);
      }

      const { choices } = buildModelChoices(discovered, byProvider);
      process.stderr.write('\n');
      if (discovered.length > 20) {
        process.stderr.write(
          `  \x1b[2m(Showing top models per provider — run "council models list" to see all ${discovered.length})\x1b[0m\n`,
        );
      }

      const selectedKeys = await checkbox({
        message: 'Choose models for your council (space to toggle, leave empty to skip):',
        choices,
        pageSize: 18,
      });

      const selected = selectedKeys
        .map(k => discovered.find(m => modelKey(m) === k))
        .filter((m): m is DiscoveredModel => !!m);

      if (selected.length > 0) {
        // --- Step 3: Connectivity test ---
        const wantTest = await confirm({
          message: 'Test model connectivity? (This makes short API calls to verify credentials, taking ~5-10s)',
          default: false,
        });

        if (wantTest) {
          process.stderr.write('\nStep 3/5: Testing model connectivity...\n');
          const testResults = await Promise.all(
            selected.map(async m => {
              const modelConfig = discoveredToModelConfig(m);
              const { ok, error } = await testConnectivity(m, modelConfig, apiAdapter);
              const icon = ok ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m';
              const suffix = ok ? '\x1b[32mready\x1b[0m' : `\x1b[31mFAILED\x1b[0m — ${error ?? 'unknown error'}`;
              process.stderr.write(`  ${icon} ${m.name.padEnd(44)} ${suffix}\n`);
              return { model: m, ok, error };
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
  }

  // --- Step 2b: Custom OpenAI-compatible endpoints (always offered) ---
  const customConfigs = await collectCustomProviders(apiAdapter);

  if (finalSelected.length === 0 && customConfigs.length === 0) {
    process.stderr.write('No models configured. Exiting setup.\n');
    return;
  }

  // Resolve collision-free names once; chairman/role-generator/prefer all reference them.
  const named = buildNamedModels(finalSelected);

  // --- Step 4: Chairman ---
  // Candidate pool spans both auto-discovered and custom providers — user can pick either.
  process.stderr.write('\nStep 4/5: Choose Chairman (synthesizes debate results)\n');
  const chairmanChoices = [
    ...named.map(n => ({ name: `${n.config.name} [${n.model.invocation}]`, value: n.config.name })),
    ...customConfigs.map(c => ({ name: `${c.name} [api, custom]`, value: c.name })),
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

  // --- Agent count range (shown with defaults; press enter to accept) ---
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
    // Cleanup orphan key files written by Step 6 \u2014 config was never saved, so the references are dead.
    for (const c of customConfigs) {
      if (c.api_credential_path) {
        try { unlinkSync(c.api_credential_path); } catch { /* already gone */ }
      }
    }
    process.stderr.write('Setup cancelled.\n');
    return;
  }

  // Decide how to reconcile with any pre-existing model set (default: keep & merge).
  let replaceAll = false;
  if (loader.hasModelConfigs()) {
    const strategy = await select({
      message: 'Existing model configuration detected \u2014 how should it be handled?',
      choices: [
        { name: 'Keep & merge (upsert selected models, preserve the rest)', value: 'merge' },
        { name: 'Replace all (delete existing model configs first)', value: 'replace' },
      ],
      default: 'merge',
    });
    replaceAll = strategy === 'replace';
  }

  // Create required directories
  mkdirSync(PATHS.config, { recursive: true });
  mkdirSync(PATHS.modelsDir, { recursive: true });
  mkdirSync(PATHS.dataDir, { recursive: true });
  mkdirSync(PATHS.sessionsDir, { recursive: true });
  mkdirSync(PATHS.checkpoints, { recursive: true });
  mkdirSync(PATHS.logs, { recursive: true });

  // Only wipe stale model files when the user explicitly chose to replace the set;
  // saveModelConfig upserts otherwise, so hand-tuned entries survive.
  if (replaceAll) {
    loader.clearAllModels();
  }

  for (const n of named) {
    loader.saveModelConfig(n.config);
  }
  for (const c of customConfigs) {
    loader.saveModelConfig(c);
  }

  // chairmanId already comes from the union pool (Step 4); use it directly, falling
  // back to the first available name from either pool if somehow unset.
  const chairmanName = chairmanId
    ?? named[0]?.config.name
    ?? customConfigs[0]?.name
    ?? '';
  const preferIds = [...named.map(n => n.config.name), ...customConfigs.map(c => c.name)];

  // Merge onto the existing council.yaml when keeping; rebuild from schema defaults
  // when replacing. Either way schema.parse guarantees a complete, valid config.
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

  process.stderr.write('\n\u2705 Configuration saved!\n');
  process.stderr.write(`   Config : ${PATHS.councilYaml}\n`);
  process.stderr.write(`   Models : ${PATHS.modelsDir}\n\n`);
  process.stderr.write('   Run "council <question>" to start your first debate!\n\n');
}

// ---------- helpers ----------

function modelKey(m: DiscoveredModel): string {
  return `${m.provider}:${m.id}:${m.invocation}`;
}

/**
 * Heuristic: does this model look like a flagship/recommended option?
 * Prefers the most capable models from each provider while excluding
 * mini/lite/experimental variants that aren't suitable as debate participants.
 */
export function isRecommended(m: DiscoveredModel): boolean {
  const id = m.id.toLowerCase();
  if (m.invocation === 'cli') return true; // CLI models are always manually installed, always recommend

  // Anthropic: claude-opus-*, claude-sonnet-4*, claude-3-5-sonnet*
  if (/opus/.test(id)) return true;
  if (/claude-sonnet-4/.test(id)) return true;
  if (/claude-3-5-sonnet/.test(id)) return true;

  // OpenAI: o3, gpt-4o, gpt-5 — not mini variants
  if (/^o[34]$/.test(id)) return true;
  if (/gpt-4o$/.test(id)) return true;
  if (/gpt-5(?!.*mini)/.test(id)) return true;

  // Google: gemini-2.5-pro, gemini-pro
  if (/gemini-2\.5-pro$/.test(id)) return true;
  if (/gemini-pro$/.test(id)) return true;

  return false;
}

type CheckboxChoice = { name: string; value: string; checked: boolean };
type CheckboxItem = CheckboxChoice | Separator;

function buildModelChoices(
  discovered: DiscoveredModel[],
  byProvider: Map<string, DiscoveredModel[]>,
): { choices: CheckboxItem[] } {
  const choices: CheckboxItem[] = [];
  const showAll = discovered.length <= 20;

  for (const [provider, models] of byProvider) {
    choices.push(new Separator(`── ${provider} ──`));

    // Sort: recommended first, then alphabetically by name
    const sorted = [...models].sort((a, b) => {
      const ra = isRecommended(a) ? 0 : 1;
      const rb = isRecommended(b) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return a.name.localeCompare(b.name);
    });

    // Limit to top models per provider when there are many
    const limit = showAll ? sorted.length : Math.min(4, sorted.length);
    const toShow = sorted.slice(0, limit);

    for (const m of toShow) {
      choices.push({
        name: `${m.name}  [${m.invocation}]`,
        value: modelKey(m),
        checked: isRecommended(m),
      });
    }
  }

  return { choices };
}

async function testConnectivity(
  m: DiscoveredModel,
  modelConfig: ModelConfig,
  apiAdapter: ApiAdapter,
): Promise<{ ok: boolean; error?: string }> {
  // CLI models: just verify binary is present — no subprocess during setup
  if (m.invocation === 'cli') {
    const binary = modelConfig.binary ?? m.provider;
    const present = hasBinary(binary);
    return present
      ? { ok: true }
      : { ok: false, error: `binary '${binary}' not found in PATH` };
  }

  // API models: make a real (short) test call
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
    return { ok: false, error: msg.length > 80 ? msg.substring(0, 80) + '\u2026' : msg };
  }
}

// ---------- OAuth login flow ----------

async function runOAuthLogins(
  credManager: CredentialManager,
  providers: Array<{ id: string; name: string }>,
): Promise<void> {
  const toLogin = await checkbox({
    message: 'Select providers to log in:',
    choices: providers.map(p => ({ name: p.name, value: p.id, checked: false })),
  });

  for (const providerId of toLogin) {
    const providerName = providers.find(p => p.id === providerId)?.name ?? providerId;
    process.stderr.write(`\n  Logging in to ${providerName}...\n`);
    try {
      await credManager.login(providerId, {
        onAuth: (info) => {
          process.stderr.write(`\n  Open this URL in your browser:\n  ${info.url}\n`);
          if (info.instructions) process.stderr.write(`  ${info.instructions}\n`);
          process.stderr.write('  Waiting for authorization...\n');
        },
        onPrompt: async (prompt) => {
          const { input } = await import('@inquirer/prompts');
          return input({ message: prompt.message, default: prompt.placeholder });
        },
        onProgress: (message) => { process.stderr.write(`  ${message}\n`); },
        onManualCodeInput: async () => {
          const { input } = await import('@inquirer/prompts');
          return input({ message: 'Enter the authorization code:' });
        },
      });
      process.stderr.write(`  \u2713 ${providerName}: logged in successfully\n`);
    } catch (err) {
      process.stderr.write(`  \u2717 ${providerName}: login failed — ${err instanceof Error ? err.message : err}\n`);
    }
  }
}

// ---------- custom OpenAI-compatible providers (optional Step 6) ----------

async function collectCustomProviders(apiAdapter: ApiAdapter): Promise<ModelConfig[]> {
  const wantCustom = await confirm({
    message: 'Add a custom OpenAI-compatible endpoint? (e.g. ollama, vLLM, LM Studio)',
    default: false,
  });
  if (!wantCustom) return [];

  const collected: ModelConfig[] = [];
  const usedNames = new Set<string>();
  process.stderr.write('\n');

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rawName = await input({
      message: 'Provider name (lowercase, a-z 0-9 -):',
      validate: (v: string) => {
        const s = sanitizeProviderName(v);
        if (!s) return 'Name must contain at least one letter or digit.';
        if (usedNames.has(s)) return `Provider '${s}' already added in this session.`;
        return true;
      },
    });
    const sanitizedName = sanitizeProviderName(rawName);

    const baseUrl = await input({
      message: 'Base URL (e.g. http://localhost:11434/v1):',
      validate: (v: string) => {
        try {
          const u = new URL(v);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'URL must use http or https.';
          return true;
        } catch {
          return 'Invalid URL.';
        }
      },
    });

    const modelIdsRaw = await input({
      message: 'Model identifier(s) — comma-separated for multiple (e.g. llama3.2 or mimo-pro,mimo-lite):',
      validate: (v: string) => {
        const ids = parseModelIds(v);
        if (ids.length === 0) return 'At least one model id is required.';
        if (new Set(ids).size !== ids.length) return 'Duplicate model ids in input.';
        return true;
      },
    });
    const modelIds = parseModelIds(modelIdsRaw);

    const apiKey = await password({
      message: 'API key (leave empty for no auth, e.g. local ollama):',
      mask: '*',
    });

    // Persist key once per provider — all models in this round share the same credential file.
    let credPath: string | undefined;
    if (apiKey.length > 0) {
      mkdirSync(PATHS.credentials, { recursive: true, mode: 0o700 });
      credPath = customCredentialPath(sanitizedName);
      writeFileSync(credPath, apiKey);
      chmodSync(credPath, 0o600);
    }

    let anyKept = false;
    for (const modelId of modelIds) {
      const cfg = buildCustomModelConfig({ sanitizedName, modelId, baseUrl, credentialPath: credPath });

      process.stderr.write(`  Testing ${cfg.name}...\n`);
      const fakeDiscovered: DiscoveredModel = {
        id: modelId,
        name: cfg.name,
        provider: cfg.provider!,
        invocation: 'api',
      };
      const { ok, error } = await testConnectivity(fakeDiscovered, cfg, apiAdapter);
      if (ok) {
        process.stderr.write(`  \x1b[32m\u2713\x1b[0m ${cfg.name} ready\n`);
        collected.push(cfg);
        anyKept = true;
      } else {
        process.stderr.write(`  \x1b[31m\u2717\x1b[0m ${cfg.name} FAILED — ${error ?? 'unknown error'}\n`);
        const keep = await confirm({ message: `Keep ${modelId} in configuration anyway?`, default: false });
        if (keep) {
          collected.push(cfg);
          anyKept = true;
        }
      }
    }

    if (anyKept) usedNames.add(sanitizedName);
    else if (credPath) {
      // No model from this round survived — clean up the orphan key file we just wrote.
      try { unlinkSync(credPath); } catch { /* already gone */ }
    }

    const more = await confirm({ message: 'Add another custom provider?', default: false });
    if (!more) break;
  }

  return collected;
}

/** Parse a comma-separated model id list, trimming and dropping empties. */
function parseModelIds(raw: string): string[] {
  return raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
}
