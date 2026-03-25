import { existsSync } from 'node:fs';
import { PATHS } from '../config/paths.js';
import { ConfigLoader } from '../config/loader.js';
import { CredentialManager } from '../providers/credentials/discovery.js';
import { AutoAdapter } from '../providers/adapter.js';
import { ApiAdapter } from '../providers/api-adapter.js';
import { CliAdapter } from '../providers/cli-adapter.js';

export async function runModelsList(): Promise<void> {
  if (!existsSync(PATHS.config)) {
    process.stderr.write('Not configured yet. Run "council setup" first.\n');
    process.exit(1);
  }

  const loader = new ConfigLoader();
  const models = loader.loadAllModels();

  if (models.length === 0) {
    process.stderr.write('No models configured. Run "council setup" to add models.\n');
    return;
  }

  process.stdout.write('\nRegistered Models:\n');
  process.stdout.write('─'.repeat(60) + '\n');

  for (const model of models) {
    const mode = model.invocation.toUpperCase();
    const status = model.enabled ? '✓' : '✗';
    const provider = model.provider ?? 'custom';
    process.stdout.write(
      `  ${status} ${model.name.padEnd(20)} ${provider.padEnd(12)} [${mode}] ` +
      `priority=${model.priority}\n`,
    );
  }

  process.stdout.write('\n');
}

export async function runModelsCheck(): Promise<void> {
  if (!existsSync(PATHS.config)) {
    process.stderr.write('Not configured yet. Run "council setup" first.\n');
    process.exit(1);
  }

  const loader = new ConfigLoader();
  const models = loader.loadAllModels();
  const credManager = new CredentialManager();
  await credManager.discoverAll();

  const apiAdapter = new ApiAdapter(credManager);
  const cliAdapter = new CliAdapter();
  const adapter = new AutoAdapter(apiAdapter, cliAdapter);

  process.stderr.write('\nChecking model health...\n');

  for (const model of models) {
    const health = await adapter.healthCheck(model);
    const icon = health.level === 'healthy' ? '✓'
               : health.level === 'degraded' ? '⚠'
               : '✗';
    process.stdout.write(`  ${icon} ${model.name}: ${health.level} — ${health.message}\n`);
  }

  process.stdout.write('\n');
}
