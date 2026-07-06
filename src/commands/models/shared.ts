import { existsSync } from 'node:fs';
import { PATHS } from '../../config/paths.js';
import { ConfigLoader } from '../../config/loader.js';

/**
 * Guard shared by every `council models …` subcommand: exit(1) with a friendly
 * pointer when Council isn't configured yet, otherwise hand back a ConfigLoader
 * bound to the real config dir. `process.exit` returns `never`, so callers can
 * treat the returned loader as always defined.
 */
export function requireConfiguredLoader(): ConfigLoader {
  if (!existsSync(PATHS.config)) {
    process.stderr.write('Not configured yet. Run "council setup" first.\n');
    process.exit(1);
  }
  return new ConfigLoader();
}
