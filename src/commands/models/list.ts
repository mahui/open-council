import { PATHS } from '../../config/paths.js';
import { formatModelLine } from '../../shared/format-model.js';
import { formatConfigError } from '../../shared/config-errors.js';
import { requireConfiguredLoader } from './shared.js';
import type { ModelConfig } from '../../types/config.js';

export async function runModelsList(): Promise<void> {
  const loader = requireConfiguredLoader();

  let models: ModelConfig[];
  let chairman: string | undefined;
  try {
    // Include disabled models so their ✗ state (and enable/disable changes) is
    // visible — orchestration filters with loadAllModels() separately.
    models = loader.loadAllModelConfigs();
    chairman = loader.loadCouncilConfig().general.default_chairman;
  } catch (err) {
    process.stderr.write(formatConfigError(err, PATHS.config) + '\n');
    process.stderr.write('运行 "council setup" 修复配置。\n');
    process.exit(1);
  }

  if (models.length === 0) {
    process.stderr.write('No models configured. Run "council setup" to add models.\n');
    return;
  }

  process.stdout.write('\nRegistered Models:\n');
  process.stdout.write('─'.repeat(60) + '\n');

  for (const model of models) {
    const status = model.enabled ? '✓' : '✗';
    const line = formatModelLine(model, { chairman: model.name === chairman, nameWidth: 20 });
    process.stdout.write(`  ${status} ${line}\n`);
  }

  process.stdout.write('\n');
  if (chairman) {
    process.stdout.write(`Default chairman: ${chairman}\n\n`);
  }
}
