/**
 * Unified model-line formatting shared across `council models`, the REPL and the
 * setup wizard so every surface presents a model the same way:
 *
 *   name  provider/model-id  [invocation]  (chairman⭐)
 *
 * Keeping a single formatter avoids the three divergent layouts we had before.
 */

import type { ModelConfig } from '../types/config.js';

export interface FormatModelOptions {
  /** Append the chairman marker when this model is the default chairman. */
  chairman?: boolean;
  /** Pad the name column to this width for table alignment. */
  nameWidth?: number;
}

export function formatModelLine(m: ModelConfig, options: FormatModelOptions = {}): string {
  const name = options.nameWidth ? m.name.padEnd(options.nameWidth) : m.name;
  const providerModel = `${m.provider ?? 'custom'}/${m.model ?? '—'}`;
  const parts = [name, providerModel, `[${m.invocation}]`];
  if (options.chairman) parts.push('(chairman⭐)');
  return parts.join('  ');
}
