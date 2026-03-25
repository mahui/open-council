import { runFirstRunWizard } from '../ui/wizard/first-run.js';

export async function runSetup(): Promise<void> {
  await runFirstRunWizard();
}
