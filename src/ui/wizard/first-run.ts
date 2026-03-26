import { mkdirSync } from 'node:fs';
import { select, confirm, checkbox } from '@inquirer/prompts';
import { PATHS } from '../../config/paths.js';
import { ConfigLoader } from '../../config/loader.js';
import { CredentialManager } from '../../providers/credentials/discovery.js';
import { discoverModels } from '../../providers/model-discovery.js';
import type { DiscoveredModel } from '../../providers/model-discovery.js';
import type { CouncilConfig, ModelConfig } from '../../types/config.js';

export async function runFirstRunWizard(): Promise<void> {
  process.stderr.write('\n🏛️  Welcome to Local AI Council!\n');
  process.stderr.write('   Let\'s set up your multi-model debate system.\n\n');

  // Step 1: Scan for available credentials
  process.stderr.write('Step 1/5: Scanning for available AI tools and credentials...\n');
  const credManager = new CredentialManager();
  const report = await credManager.discoverAll();

  const available: string[] = [];
  for (const [provider, result] of Object.entries(report)) {
    if (result.status === 'valid' || result.status === 'refreshed') {
      process.stderr.write(`  ✓ ${provider}: ${result.status} (${result.source})\n`);
      available.push(provider);
    } else {
      process.stderr.write(`  ✗ ${provider}: ${result.status}\n`);
    }
  }

  // Step 2: Discover models dynamically
  process.stderr.write('\nStep 2/5: Discovering available models...\n');
  const discovered = await discoverModels(credManager);

  if (discovered.length === 0) {
    process.stderr.write('\n⚠ No models found. Ensure you have:\n');
    process.stderr.write('  - API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY)\n');
    process.stderr.write('  - Or CLI tools installed (claude, codex, gemini)\n');
    process.stderr.write('  Then run "council setup" again.\n\n');
    return;
  }

  // Group by provider for display
  const byProvider = new Map<string, DiscoveredModel[]>();
  for (const m of discovered) {
    const list = byProvider.get(m.provider) ?? [];
    list.push(m);
    byProvider.set(m.provider, list);
  }

  for (const [provider, models] of byProvider) {
    process.stderr.write(`  ${provider}: ${models.length} model(s) available\n`);
  }

  // Select models
  process.stderr.write('\n');
  const selectedIds = await checkbox({
    message: 'Choose models for your council:',
    choices: discovered.map(m => ({
      name: `${m.name} [${m.provider}/${m.invocation}]`,
      value: m.id + '|' + m.invocation,
      checked: false,
    })),
  });

  if (selectedIds.length === 0) {
    process.stderr.write('No models selected. Exiting setup.\n');
    return;
  }

  const selected = selectedIds.map(idInv => {
    const [id, inv] = idInv.split('|');
    return discovered.find(m => m.id === id && m.invocation === inv)!;
  }).filter(Boolean);

  // Step 3: Verify connectivity
  process.stderr.write('\nStep 3/5: Verifying model access...\n');
  for (const m of selected) {
    process.stderr.write(`  ✓ ${m.name} (${m.invocation}) ready\n`);
  }

  // Step 4: Select Chairman
  process.stderr.write('\nStep 4/5: Select Chairman model (synthesizes debate results)\n');
  const chairmanId = await select({
    message: 'Chairman model:',
    choices: selected.map(m => ({
      name: `${m.name} [${m.invocation}]`,
      value: m.id,
    })),
  });

  // Step 5: Default mode
  process.stderr.write('\nStep 5/5: Default debate mode\n');
  const defaultMode = await select({
    message: 'Default mode:',
    choices: [
      { name: 'auto - Automatically choose based on question complexity', value: 'auto' },
      { name: 'compare - Multiple models + synthesis', value: 'compare' },
      { name: 'debate - Full debate with peer review', value: 'debate' },
      { name: 'quick - Single model, fast response', value: 'quick' },
    ],
  }) as 'auto' | 'compare' | 'debate' | 'quick';

  // Save configuration
  const confirmed = await confirm({ message: 'Save configuration?' });
  if (!confirmed) {
    process.stderr.write('Setup cancelled.\n');
    return;
  }

  // Create directories
  mkdirSync(PATHS.config, { recursive: true });
  mkdirSync(PATHS.modelsDir, { recursive: true });
  mkdirSync(PATHS.dataDir, { recursive: true });
  mkdirSync(PATHS.sessionsDir, { recursive: true });
  mkdirSync(PATHS.checkpoints, { recursive: true });
  mkdirSync(PATHS.logs, { recursive: true });

  const loader = new ConfigLoader();

  // Save model configs
  for (const m of selected) {
    const modelConfig = discoveredToModelConfig(m);
    loader.saveModelConfig(modelConfig);
  }

  // Save main config
  const chairmanName = selected.find(m => m.id === chairmanId)?.id ?? selected[0]!.id;
  const config: CouncilConfig = {
    schema_version: 1,
    general: {
      default_mode: defaultMode,
      default_chairman: chairmanName,
      min_agents: 2,
      max_agents: 5,
      allow_same_model_agents: true,
      review_rounds: 1,
      language: 'auto',
      compression_threshold_ratio: 0.6,
      devil_advocate: 'auto',
      high_risk_keywords: [],
    },
    storage: {
      data_dir: PATHS.dataDir,
      checkpoint_dir: PATHS.checkpoints,
      log_dir: PATHS.logs,
      log_retention_days: 7,
      orphan_checkpoint_hours: 24,
    },
    routing: {
      strategy: 'keyword',
      dynamic_weight: true,
      dynamic_weight_alpha: 0.3,
      dynamic_weight_shadow: true,
      exploration_rate: 0.1,
      rules: [],
      default: {
        prefer: selected.map(m => m.id),
        chairman: chairmanName,
        role_set: 'default',
      },
    },
    concurrency: {
      global_resource_limit: 10,
    },
    circuit_breaker: {
      failure_threshold: 5,
      recovery_seconds: 3600,
      enabled: true,
    },
    output: {
      format: 'markdown',
      show_individual: false,
      show_scores: true,
      show_consensus: true,
      show_dimension_heatmap: true,
      show_timing: true,
      copy_to_clipboard: false,
      tui_mode: 'auto',
    },
    storage_security: {
      session_retention_days: 90,
    },
  };

  loader.saveCouncilConfig(config);

  process.stderr.write('\n✅ Configuration saved!\n');
  process.stderr.write(`   Config: ${PATHS.councilYaml}\n`);
  process.stderr.write(`   Models: ${PATHS.modelsDir}\n\n`);
  process.stderr.write('   Run "council <question>" to start your first debate!\n\n');
}

function discoveredToModelConfig(m: DiscoveredModel): ModelConfig {
  const base: ModelConfig = {
    name: m.id,
    invocation: m.invocation,
    provider: m.provider,
    model: m.id,
    timeout_seconds: 120,
    capabilities: ['general', 'code', 'analysis'],
    priority: m.provider === 'anthropic' ? 100 : m.provider === 'openai' ? 90 : 80,
    max_concurrent: 1,
    resource_weight: 1,
    enabled: true,
    streaming: m.invocation === 'api',
  };

  // CLI-specific config
  if (m.invocation === 'cli') {
    if (m.provider === 'anthropic') {
      base.binary = 'claude';
      base.args = ['-p', '--model', m.id];
      base.input_mode = 'arg';
    } else if (m.provider === 'openai') {
      base.binary = 'codex';
      base.args = ['exec', '-m', m.id, '-c', 'approval_policy="never"', '--json'];
      base.input_mode = 'arg';
    }
  }

  return base;
}
