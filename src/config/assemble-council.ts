/**
 * Council config assembly — build a complete, schema-valid CouncilConfig from a
 * set of decided fields, merging onto an existing config when present.
 *
 * Extracted from `src/ui/wizard/first-run.ts` (design-notes/web-gui-config.md §6)
 * so both the CLI Setup Wizard and the Web GUI config server share one merge
 * semantics — the two never drift out of sync. Depends only on the config layer
 * (schema + paths); ui/server both depend downward on it.
 */

import { PATHS } from './paths.js';
import { CouncilConfigSchema } from './schema.js';
import type { CouncilConfig } from '../types/config.js';

/**
 * Build a complete, schema-valid CouncilConfig from decided fields.
 * When `base` is provided (reconfigure/merge) only the given fields are
 * overridden — every other field the user hand-tuned is preserved. When `base`
 * is null the config is derived from schema defaults, so the two paths never
 * drift out of sync with the schema.
 */
export function assembleConfig(opts: {
  generalOverride: Partial<CouncilConfig['general']>;
  prefer: string[];
  chairman: string;
  base: CouncilConfig | null;
}): CouncilConfig {
  const { generalOverride, prefer, chairman, base } = opts;

  if (base) {
    const merged = {
      ...base,
      general: { ...base.general, ...generalOverride },
      routing: { ...base.routing, default: { ...base.routing.default, prefer, chairman } },
    };
    return CouncilConfigSchema.parse(merged) as unknown as CouncilConfig;
  }

  const minimal = {
    general: generalOverride,
    storage: {
      data_dir: PATHS.dataDir,
      checkpoint_dir: PATHS.checkpoints,
      log_dir: PATHS.logs,
    },
    routing: { default: { prefer, chairman } },
  };
  return CouncilConfigSchema.parse(minimal) as unknown as CouncilConfig;
}
