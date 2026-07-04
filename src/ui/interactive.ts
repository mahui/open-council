/**
 * Interactive TTY helpers — single-key prompts and the post-debate viewer
 * offer. Shared between the initial debate output and the historical-reuse
 * path so the "Press Enter to explore" flow lives in one place.
 */

import type { Session } from '../types/session.js';
import { hasViewableContent, startViewer } from './viewer.js';

/**
 * Wait for a single keypress in raw mode. Resolves true if the user pressed
 * Enter/Space (proceed), false otherwise. Resolves false immediately when
 * stdin is not a TTY.
 */
export function waitForKey(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { resolve(false); return; }
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    const onData = (key: string): void => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      if (key === '\r' || key === '\n' || key === ' ') {
        resolve(true);
      } else {
        process.stderr.write('\n');
        resolve(false);
      }
    };
    process.stdin.on('data', onData);
  });
}

/**
 * In TTY mode, offer to open the interactive viewer for a completed session
 * with multiple agent responses. No-op otherwise.
 */
export async function offerViewer(session: Session): Promise<void> {
  if (process.stderr.isTTY && hasViewableContent(session) && session.agents.length > 1) {
    process.stderr.write(`\n${'\x1b[2m'}Press Enter to explore responses, or q to exit...${'\x1b[0m'}`);
    const shouldView = await waitForKey();
    if (shouldView) {
      await startViewer(session);
    }
  }
}
