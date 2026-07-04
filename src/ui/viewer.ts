/**
 * Interactive post-debate viewer.
 * Lets user switch between agent outputs and compare differences.
 */

import type { Session, Invocation } from '../types/session.js';
import { renderMarkdown } from './markdown.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const BG_CYAN = '\x1b[46m\x1b[30m';
const CLEAR = '\x1b[2J\x1b[H';

const ROLE_ICONS: Record<string, string> = {
  analyst: '🔍',
  engineer: '⚙️',
  innovator: '💡',
  critic: '🎯',
  pragmatist: '📐',
};

interface ViewState {
  mode: 'agent' | 'synthesis' | 'diff';
  agentIndex: number;
}

export function hasViewableContent(session: Session): boolean {
  const invocations = getSuccessfulInvocations(session);
  return invocations.length > 0;
}

export async function startViewer(session: Session): Promise<void> {
  const invocations = getSuccessfulInvocations(session);
  if (invocations.length === 0) return;

  const state: ViewState = {
    mode: session.synthesis ? 'synthesis' : 'agent',
    agentIndex: 0,
  };

  // Enable raw mode for keypress handling
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  render(session, invocations, state);

  return new Promise<void>((resolve) => {
    const onData = (key: string) => {
      // ctrl-c or q to quit
      if (key === '\u0003' || key === 'q' || key === 'Q') {
        cleanup();
        resolve();
        return;
      }

      // Number keys: switch to agent view
      const num = parseInt(key, 10);
      if (num >= 1 && num <= invocations.length) {
        state.mode = 'agent';
        state.agentIndex = num - 1;
        render(session, invocations, state);
        return;
      }

      // Arrow keys (escape sequences)
      if (key === '\x1b[C' || key === 'l') {
        // Right arrow: next
        if (state.mode === 'agent') {
          state.agentIndex = (state.agentIndex + 1) % invocations.length;
        }
        render(session, invocations, state);
        return;
      }
      if (key === '\x1b[D' || key === 'h') {
        // Left arrow: prev
        if (state.mode === 'agent') {
          state.agentIndex = (state.agentIndex - 1 + invocations.length) % invocations.length;
        }
        render(session, invocations, state);
        return;
      }

      // s: synthesis view
      if ((key === 's' || key === 'S') && session.synthesis) {
        state.mode = 'synthesis';
        render(session, invocations, state);
        return;
      }

      // d: diff/comparison view
      if (key === 'd' || key === 'D') {
        state.mode = 'diff';
        render(session, invocations, state);
        return;
      }
    };

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write('\n');
    };

    process.stdin.on('data', onData);
  });
}

function render(session: Session, invocations: Invocation[], state: ViewState): void {
  process.stderr.write(CLEAR);

  // Tab bar
  renderTabBar(invocations, session, state);

  process.stderr.write('\n');

  switch (state.mode) {
    case 'agent':
      renderAgentView(invocations[state.agentIndex]!);
      break;
    case 'synthesis':
      renderSynthesisView(session);
      break;
    case 'diff':
      renderDiffView(invocations);
      break;
  }

  // Footer
  process.stderr.write(`\n${DIM}─────────────────────────────────────────────────${RESET}\n`);
  process.stderr.write(`${DIM}  ←/→ switch agents  |  s synthesis  |  d compare  |  q quit${RESET}\n`);
}

function renderTabBar(invocations: Invocation[], session: Session, state: ViewState): void {
  const tabs: string[] = [];

  for (let i = 0; i < invocations.length; i++) {
    const inv = invocations[i]!;
    const icon = ROLE_ICONS[inv.role] ?? '🤖';
    const label = `${i + 1}:${icon} ${inv.model_name}`;
    if (state.mode === 'agent' && state.agentIndex === i) {
      tabs.push(`${BG_CYAN} ${label} ${RESET}`);
    } else {
      tabs.push(`${DIM} ${label} ${RESET}`);
    }
  }

  if (session.synthesis) {
    const sLabel = 'S:👑 Synthesis';
    if (state.mode === 'synthesis') {
      tabs.push(`${BG_CYAN} ${sLabel} ${RESET}`);
    } else {
      tabs.push(`${DIM} ${sLabel} ${RESET}`);
    }
  }

  const dLabel = 'D:⚖️ Compare';
  if (state.mode === 'diff') {
    tabs.push(`${BG_CYAN} ${dLabel} ${RESET}`);
  } else {
    tabs.push(`${DIM} ${dLabel} ${RESET}`);
  }

  process.stderr.write(tabs.join('  ') + '\n');
}

function renderAgentView(inv: Invocation): void {
  const icon = ROLE_ICONS[inv.role] ?? '🤖';
  const time = (inv.result.elapsed_ms / 1000).toFixed(1);
  const mode = inv.result.invocation_mode === 'api' ? 'API' : 'CLI';

  process.stderr.write(
    `${BOLD}${icon} ${inv.model_name}${RESET} ${DIM}(${inv.role}) ${time}s [${mode}]${RESET}\n\n`,
  );

  process.stdout.write(renderMarkdown(inv.response_raw) + '\n');
}

function renderSynthesisView(session: Session): void {
  if (!session.synthesis) return;

  process.stderr.write(`${BOLD}👑 Chairman Synthesis${RESET}\n\n`);
  process.stdout.write(renderMarkdown(session.synthesis) + '\n');
}

function renderDiffView(invocations: Invocation[]): void {
  process.stderr.write(`${BOLD}⚖️  Response Comparison${RESET}\n\n`);

  if (invocations.length < 2) {
    process.stderr.write(`${DIM}Need at least 2 agents to compare.${RESET}\n`);
    return;
  }

  // Extract key points from each response
  const summaries = invocations.map(inv => ({
    name: inv.model_name,
    role: inv.role,
    icon: ROLE_ICONS[inv.role] ?? '🤖',
    points: extractKeyPoints(inv.response_raw),
    length: inv.response_raw.length,
    time: inv.result.elapsed_ms,
  }));

  // Stats comparison
  process.stderr.write(`${BOLD}Response Stats${RESET}\n`);
  const maxNameLen = Math.max(...summaries.map(s => s.name.length));
  for (const s of summaries) {
    const nameCol = s.name.padEnd(maxNameLen);
    const lenBar = '█'.repeat(Math.min(30, Math.round(s.length / 100)));
    process.stderr.write(
      `  ${s.icon} ${BOLD}${nameCol}${RESET}  ${DIM}${(s.time / 1000).toFixed(1)}s${RESET}  ${CYAN}${lenBar}${RESET} ${DIM}${s.length} chars${RESET}\n`,
    );
  }

  // Key points comparison
  process.stderr.write(`\n${BOLD}Key Points by Agent${RESET}\n\n`);
  for (const s of summaries) {
    process.stderr.write(`  ${s.icon} ${BOLD}${s.name}${RESET} ${DIM}(${s.role})${RESET}\n`);
    for (const point of s.points.slice(0, 5)) {
      process.stderr.write(`    ${DIM}•${RESET} ${point}\n`);
    }
    process.stderr.write('\n');
  }

  // Find unique perspectives
  renderUniqueInsights(summaries);
}

function extractKeyPoints(text: string): string[] {
  const points: string[] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    // Extract headers as key points
    if (trimmed.startsWith('#')) {
      const cleaned = trimmed.replace(/^#+\s*/, '').replace(/\*\*/g, '');
      if (cleaned.length > 5 && cleaned.length < 120) {
        points.push(cleaned);
      }
    }
    // Extract bold statements
    const boldMatch = trimmed.match(/\*\*([^*]{10,80})\*\*/);
    if (boldMatch && !trimmed.startsWith('#')) {
      points.push(boldMatch[1]!);
    }
  }

  // Deduplicate
  return [...new Set(points)];
}

function renderUniqueInsights(
  summaries: Array<{ name: string; icon: string; points: string[] }>,
): void {
  if (summaries.length < 2) return;

  process.stderr.write(`${BOLD}Unique Perspectives${RESET}\n\n`);

  for (const s of summaries) {
    const otherPoints = summaries
      .filter(o => o.name !== s.name)
      .flatMap(o => o.points.map(p => p.toLowerCase()));

    const unique = s.points.filter(p =>
      !otherPoints.some(op => op.includes(p.toLowerCase().substring(0, 20)) || p.toLowerCase().includes(op.substring(0, 20))),
    );

    if (unique.length > 0) {
      process.stderr.write(`  ${s.icon} ${BOLD}${s.name}${RESET} ${DIM}unique insights:${RESET}\n`);
      for (const u of unique.slice(0, 3)) {
        process.stderr.write(`    ${YELLOW}→${RESET} ${u}\n`);
      }
      process.stderr.write('\n');
    }
  }
}

function getSuccessfulInvocations(session: Session): Invocation[] {
  const broadcastStage = session.stages.find(s => s.phase === 'broadcast');
  if (!broadcastStage) return [];
  return broadcastStage.invocations.filter(i => !i.timed_out && i.response_raw);
}
