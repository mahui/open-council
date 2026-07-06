import { requireConfiguredLoader } from './shared.js';
import { removeModelConfig, setModelEnabled } from './mutations.js';

const NOT_FOUND = (name: string): string =>
  `Error: no model named '${name}'. Run "council models list" to see registered models.\n`;

/** Delete a model YAML by name. Missing name → exit 1 with a clear message. */
export function runModelsRemove(name: string): void {
  const loader = requireConfiguredLoader();
  if (removeModelConfig(loader, name).status === 'missing') {
    process.stderr.write(NOT_FOUND(name));
    process.exit(1);
  }
  process.stdout.write(`Removed model '${name}'.\n`);
}

/** Flip a model's `enabled` flag on. */
export function runModelsEnable(name: string): void {
  setEnabledAndReport(name, true);
}

/** Flip a model's `enabled` flag off. */
export function runModelsDisable(name: string): void {
  setEnabledAndReport(name, false);
}

function setEnabledAndReport(name: string, enabled: boolean): void {
  const loader = requireConfiguredLoader();
  const result = setModelEnabled(loader, name, enabled);
  const verb = enabled ? 'enabled' : 'disabled';

  if (result.status === 'missing') {
    process.stderr.write(NOT_FOUND(name));
    process.exit(1);
  }
  if (result.status === 'noop') {
    process.stderr.write(`Model '${name}' is already ${verb}.\n`);
    return;
  }
  process.stdout.write(`Model '${name}' ${verb}.\n`);
}
