import { confirm } from '@inquirer/prompts';
import { ApiAdapter } from '../../providers/api-adapter.js';
import { CredentialManager } from '../../providers/credentials/discovery.js';
import { getHealthSummary, resetCircuitBreaker } from '../../providers/health.js';
import { requireConfiguredLoader } from './shared.js';

export async function runModelsCheck(): Promise<void> {
  const loader = requireConfiguredLoader();
  const models = loader.loadAllModels();
  const adapter = new ApiAdapter(new CredentialManager());

  process.stderr.write('\nChecking model health...\n');

  for (const model of models) {
    const health = await adapter.healthCheck(model);
    const icon = health.level === 'healthy' ? '✓'
               : health.level === 'degraded' ? '⚠'
               : '✗';
    process.stdout.write(`  ${icon} ${model.name}: ${health.level} — ${health.message}\n`);
  }

  process.stdout.write('\n');

  // Display circuit breaker status
  const summary = getHealthSummary();
  const melted = summary.filter(s => s.status === 'open');

  if (melted.length > 0) {
    process.stderr.write('\x1b[31m⚠ The following providers have open circuits (melted due to repeated failures):\x1b[0m\n');
    for (const p of melted) {
      process.stderr.write(`  - ${p.provider} (${p.failures} consecutive failures)\n`);
    }

    const reset = await confirm({ message: 'Would you like to manually reset these circuit breakers?' });
    if (reset) {
      for (const p of melted) {
        resetCircuitBreaker(p.provider);
      }
      process.stderr.write('Circuit breakers reset successfully.\n');
    }
  }
}
