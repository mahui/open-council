/**
 * Follow-up mode: after a debate completes, allow the user to ask
 * follow-up questions that build on the previous synthesis.
 */

import { createInterface } from 'node:readline';
import type { Session } from '../types/session.js';
import type { Orchestrator } from '../core/orchestrator.js';
import type { Renderer } from '../types/renderer.js';

export async function enterFollowUpMode(
  session: Session,
  orchestrator: Orchestrator,
  renderer: Renderer,
): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });

  process.stderr.write('\n  Follow-up mode (type your question, or "exit" to quit):\n');

  const askQuestion = (): Promise<string> => {
    return new Promise((resolve) => {
      rl.question('  > ', (answer) => {
        resolve(answer.trim());
      });
    });
  };

  let currentSession = session;

  while (true) {
    const input = await askQuestion();

    if (!input || input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      break;
    }

    try {
      const followUpSession = await orchestrator.run(input, {
        mode: currentSession.resolved_mode as Session['mode'],
        parentSessionId: currentSession.session_id,
      });

      renderer.renderResult(followUpSession);
      currentSession = followUpSession;
    } catch (err) {
      process.stderr.write(`  Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  rl.close();
  process.stderr.write('  Session ended.\n');
}
