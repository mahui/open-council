/**
 * Renderer factory — selects TUI vs plain renderer based on TTY + config.
 * Centralises the `process.stderr.isTTY` / `tui_mode` decision so command
 * files don't duplicate it (ARCH-03).
 */

import { PlainRenderer } from './plain-renderer.js';
import type { Renderer } from './renderer.js';

export interface RendererFactoryOptions {
  question: string;
  mode: string;
  json?: boolean;
  tuiMode: 'auto' | 'always' | 'never';
}

/**
 * Create the renderer for an interactive debate run. Uses the ink-based
 * TuiRenderer when attached to a TTY, not in JSON mode, and TUI is not
 * disabled; otherwise falls back to the pipe-friendly PlainRenderer.
 */
export async function createRenderer(options: RendererFactoryOptions): Promise<Renderer> {
  const useTui = process.stderr.isTTY && !options.json && options.tuiMode !== 'never';

  if (useTui) {
    try {
      const { TuiRenderer } = await import('./tui/TuiRenderer.js');
      return new TuiRenderer(options.question, options.mode ?? 'auto');
    } catch {
      // ink/react not installed or failed to load — fall back to PlainRenderer
    }
  }

  return new PlainRenderer();
}
