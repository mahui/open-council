/**
 * Live TUI renderer with switchable tabs per agent.
 * During debate, each agent streams into its own tab.
 * User can switch tabs with ←/→ while agents are running.
 */

import type { Agent, DebatePhase, DegradationEvent, ConsensusResult, Session } from '../types/session.js';
import type { InvocationResult } from '../types/provider.js';
import type { Renderer } from './renderer.js';
import { renderMarkdown } from './markdown.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BG_ACTIVE = '\x1b[46m\x1b[30m';
const BG_DONE = '\x1b[42m\x1b[30m';
const BG_FAIL = '\x1b[41m\x1b[37m';
const CLEAR_SCREEN = '\x1b[2J\x1b[H';
const CLEAR_LINE = '\x1b[2K';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// cursor positioning uses absolute \x1b[row;colH only

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Display width of a single code point at index i. CJK/emoji = 2, ASCII = 1. */
function charWidth(str: string, i: number): number {
  const code = str.charCodeAt(i);
  if (code >= 0xD800 && code <= 0xDBFF) return 2; // high surrogate (emoji etc.)
  if (
    (code >= 0x1100 && code <= 0x115F) ||
    (code >= 0x2E80 && code <= 0x303E) ||
    (code >= 0x3040 && code <= 0x33BF) ||
    (code >= 0x3400 && code <= 0x4DBF) ||
    (code >= 0x4E00 && code <= 0xA4CF) ||
    (code >= 0xAC00 && code <= 0xD7AF) ||
    (code >= 0xF900 && code <= 0xFAFF) ||
    (code >= 0xFE30 && code <= 0xFE4F) ||
    (code >= 0xFF01 && code <= 0xFF60) ||
    (code >= 0xFFE0 && code <= 0xFFE6)
  ) return 2;
  return 1;
}

/** Visible (printable) display width of an ANSI-bearing string. */
function visibleWidth(str: string): number {
  let w = 0;
  let inEscape = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]!;
    if (ch === '\x1b') { inEscape = true; continue; }
    if (inEscape) { if (ch === 'm') inEscape = false; continue; }
    const cw = charWidth(str, i);
    w += cw;
    if (cw === 2 && str.charCodeAt(i) >= 0xD800 && str.charCodeAt(i) <= 0xDBFF) i++;
  }
  return w;
}

const ROLE_ICONS: Record<string, string> = {
  analyst: '🔍', engineer: '⚙️', innovator: '💡',
  critic: '🎯', pragmatist: '📐', chairman: '👑',
};

interface TabState {
  id: string;
  label: string;
  icon: string;
  status: 'pending' | 'streaming' | 'done' | 'failed';
  buffer: string;
  /** Scroll position: 0 = pinned to bottom (auto-scroll), >0 = scrolled up N lines */
  scrollUp: number;
  elapsed?: number;
  mode?: string;
}

export class LiveRenderer implements Renderer {
  private tabs: TabState[] = [];
  private activeTab = 0;
  private phase = '';
  private keypressHandler: ((ch: string | undefined, key: any) => void) | null = null;
  private resizeHandler: (() => void) | null = null;
  private rows = process.stderr.rows || 40;
  private cols = process.stderr.columns || 80;
  private headerLines = 3; // tab bar + phase + separator
  private footerLines = 3; // separator + activity log + hint
  private listening = false;
  private synthBuffer = '';
  private activityLog = '';   // one-line status shown in footer
  private tabModels = new Map<string, string>(); // tab id → model name

  /** Update the activity log line in the footer (non-intrusive status) */
  private log(msg: string): void {
    this.activityLog = msg;
    if (this.listening || this.tabs.length > 0) {
      // TUI active: update footer only
      this.renderFooter();
    } else {
      // Pre-TUI: write to stderr as a transient status line
      process.stderr.write(`\r${CLEAR_LINE}${DIM}  ${msg}${RESET}`);
    }
  }

  onPhaseStart(phase: DebatePhase, _index: number, _total: number): void {
    this.phase = phase;

    if (phase === 'route') {
      this.log('Analyzing question and generating expert roles...');
    } else if (phase === 'broadcast' || phase === 'cross_examine') {
      this.log(phase === 'cross_examine' ? 'Cross-examination round starting...' : 'Broadcasting question to experts...');
      this.startLiveMode();
    } else if (phase === 'synthesis') {
      this.log('Chairman synthesizing all perspectives...');
      this.tabs.push({
        id: '__synthesis__',
        label: 'Synthesis',
        icon: '👑',
        status: 'pending',
        buffer: '',
        scrollUp: 0,
      });
      this.activeTab = this.tabs.length - 1;
      this.synthBuffer = '';
      this.render();
    } else if (phase === 'review') {
      this.log('Peer review: experts evaluating each other...');
      this.tabs.push({
        id: '__review__',
        label: 'Peer Review',
        icon: '📋',
        status: 'pending',
        buffer: '',
        scrollUp: 0,
      });
      this.activeTab = this.tabs.length - 1;
      this.render();
    } else if (phase === 'consensus') {
      this.log('Computing consensus scores...');
    } else if (phase === 'pre_synthesis_compression') {
      this.log('Compressing responses to fit synthesis context...');
    }
  }

  onAgentStart(agent: Agent): void {
    const existing = this.tabs.find(t => t.id === agent.agent_id);

    this.log(`${agent.role} [${agent.config.name}] generating response...`);
    this.tabModels.set(agent.agent_id, agent.config.name);

    if (existing) {
      existing.status = 'streaming';
      existing.buffer = `${DIM}Thinking...${RESET}\n`;
      existing.scrollUp = 0;
    } else {
      this.tabs.push({
        id: agent.agent_id,
        label: agent.role,
        icon: '',
        status: 'streaming',
        buffer: `${DIM}${agent.role_description}\nModel: ${agent.config.name} [${agent.config.provider}]${RESET}\n\n${DIM}Thinking...${RESET}\n`,
        scrollUp: 0,
      });
    }

    // Auto-focus first streaming tab
    if (this.tabs.filter(t => t.status === 'streaming').length === 1) {
      this.activeTab = this.tabs.findIndex(t => t.id === agent.agent_id);
    }

    this.render();
  }

  onAgentProgress(agent: Agent, chunk: string): void {
    const tab = this.tabs.find(t => t.id === agent.agent_id)
      ?? this.tabs.find(t => t.id === '__synthesis__' && this.phase === 'synthesis');
    if (!tab) return;

    // Replace "Thinking..." on first real chunk
    if (tab.buffer.includes('Thinking...')) {
      tab.buffer = '';
    }

    tab.buffer += chunk;

    if (this.phase === 'synthesis') {
      this.synthBuffer += chunk;
    }

    // Only redraw if this is the active tab
    if (this.tabs[this.activeTab]?.id === tab.id) {
      this.renderContent();
    } else {
      // Just update the tab bar to show activity indicator
      this.renderTabBar();
    }
  }

  onAgentComplete(agent: Agent, result: InvocationResult): void {
    const tab = this.tabs.find(t => t.id === agent.agent_id)
      ?? this.tabs.find(t => t.id === '__synthesis__' && this.phase === 'synthesis')
      ?? this.tabs.find(t => t.id === '__review__' && this.phase === 'review');
    if (!tab) return;

    tab.status = result.timed_out ? 'failed' : 'done';
    tab.elapsed = result.elapsed_ms;
    tab.mode = result.invocation_mode === 'api' ? 'API' : 'CLI';

    if (tab.buffer.includes('Thinking...') || tab.buffer.trim() === '') {
      tab.buffer = result.response;
    }

    const time = (result.elapsed_ms / 1000).toFixed(1);
    const done = this.tabs.filter(t => t.status === 'done' || t.status === 'failed').length;
    const total = this.tabs.filter(t => t.id !== '__synthesis__' && t.id !== '__review__').length;
    this.log(`✓ ${agent.role} done (${time}s) — ${done}/${total} experts completed`);

    this.render();
  }

  onConsensus(result: ConsensusResult): void {
    const score = result.consensus_score;
    const filled = Math.round(score * 20);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    const level = score >= 0.8 ? 'High ✓'
                : score >= 0.5 ? 'Medium'
                : score >= 0.2 ? 'Low ⚠'
                : 'Very Low ✗';
    const color = score >= 0.6 ? GREEN : score >= 0.3 ? YELLOW : RED;

    let display = `\n${BOLD}Consensus Score${RESET}\n\n`;
    display += `  ${color}${score.toFixed(2)}${RESET} ${bar} ${BOLD}${level}${RESET}\n\n`;
    display += `  Model diversity: ${result.model_diversity_factor.toFixed(2)}\n`;
    display += `  Raw agreement:   ${result.raw_agreement.toFixed(2)}\n\n`;

    // Dimension breakdown
    display += `${BOLD}Dimension Analysis${RESET}\n\n`;
    for (const [dim, { score: dimScore, divergence }] of Object.entries(result.dimension_scores)) {
      const dimFilled = Math.round(Math.max(0, Math.min(1, dimScore)) * 15);
      const dimBar = '█'.repeat(dimFilled) + '░'.repeat(15 - dimFilled);
      const dimColor = divergence < 1.0 ? GREEN : divergence < 2.0 ? YELLOW : RED;
      const dimLabel = dim.charAt(0).toUpperCase() + dim.slice(1);
      display += `  ${dimLabel.padEnd(15)} ${dimColor}${dimBar}${RESET} σ=${divergence.toFixed(1)}\n`;
    }

    if (score < 0.6) {
      display += `\n${YELLOW}→ Below threshold (0.6), cross-examination may follow${RESET}\n`;
    }

    const reviewTab = this.tabs.find(t => t.id === '__review__');
    if (reviewTab) {
      reviewTab.buffer += display;
    }

    this.log(`Consensus: ${score.toFixed(2)} (${level})`);
    this.render();
  }

  onDegradation(event: DegradationEvent): void {
    this.log(`⚠ ${event.impact}`);
    const tab = this.tabs[this.activeTab];
    if (tab) {
      tab.buffer += `\n${YELLOW}⚠ ${event.phase}: ${event.impact}${RESET}\n`;
      this.render();
    }
  }

  renderResult(session: Session): void {
    this.stopListening();
    process.stderr.write(SHOW_CURSOR);

    // Final output to stdout (for piping)
    const text = this.synthBuffer || session.synthesis
      || session.stages.find(s => s.phase === 'broadcast')?.invocations
        .filter(i => !i.timed_out && i.response_raw)?.[0]?.response_raw;

    if (text) {
      // Don't output to stdout since we showed it in TUI already
      // But store it so it can be piped if needed
    }

    // Show summary
    if (session.total_elapsed_ms) {
      const agents = session.agents.length;
      const succeeded = session.stages
        .flatMap(s => s.invocations)
        .filter(i => !i.timed_out && i.response_raw).length;

      // Move to bottom of screen
      process.stderr.write(`\x1b[${this.rows};1H`);
      process.stderr.write(
        `${CLEAR_LINE}${DIM}Total: ${(session.total_elapsed_ms / 1000).toFixed(1)}s | ` +
        `Mode: ${session.resolved_mode} | Agents: ${succeeded}/${agents}  ` +
        `← → switch tabs  q exit${RESET}`,
      );
    }
  }

  /** Mark a tab as failed (called from orchestrator error handler) */
  markFailed(agentId: string, error: string): void {
    const tab = this.tabs.find(t => t.id === agentId);
    if (tab) {
      tab.status = 'failed';
      tab.buffer = `${RED}Failed: ${error}${RESET}\n`;
      this.render();
    }
  }

  /** Enter interactive browse mode after debate completes */
  async browse(): Promise<void> {
    if (this.tabs.length === 0) return;

    return new Promise<void>((resolve) => {
      this.stopListening();
      this.startListening(() => {
        this.stopListening();
        process.stderr.write(SHOW_CURSOR);
        process.stderr.write(CLEAR_SCREEN);
        resolve();
      });
      this.render();
    });
  }

  // --- Internal ---

  private startLiveMode(): void {
    process.stderr.write(HIDE_CURSOR);
    process.stderr.write(CLEAR_SCREEN);
    this.listenResize();
    this.startListening();
    this.render();
  }

  private listenResize(): void {
    if (this.resizeHandler) return;
    this.resizeHandler = () => {
      this.rows = process.stderr.rows || 40;
      this.cols = process.stderr.columns || 80;
      // Clear and fully re-render with new dimensions
      process.stderr.write(CLEAR_SCREEN);
      this.render();
    };
    process.stdout.on('resize', this.resizeHandler);
  }

  private stopResize(): void {
    if (this.resizeHandler) {
      process.stdout.removeListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
  }

  private startListening(onQuit?: () => void): void {
    if (this.listening) return;
    this.listening = true;

    this.keypressHandler = (_ch, key) => {
      if (!key) return;
      const tab = this.tabs[this.activeTab];

      if (key.name === 'right' || (_ch === 'l' && !key.ctrl)) {
        this.activeTab = (this.activeTab + 1) % this.tabs.length;
        this.render();
      } else if (key.name === 'left' || (_ch === 'h' && !key.ctrl)) {
        this.activeTab = (this.activeTab - 1 + this.tabs.length) % this.tabs.length;
        this.render();
      } else if (key.name === 'up' || (_ch === 'k' && !key.ctrl)) {
        // Scroll up
        if (tab) {
          const contentRows = this.rows - this.headerLines - this.footerLines;
          const totalLines = this.getRenderedLines(tab).length;
          const maxScroll = Math.max(0, totalLines - contentRows);
          tab.scrollUp = Math.min(tab.scrollUp + 3, maxScroll);
          this.renderContent();
          this.renderFooter();
        }
      } else if (key.name === 'down' || (_ch === 'j' && !key.ctrl)) {
        // Scroll down (toward bottom)
        if (tab) {
          tab.scrollUp = Math.max(0, tab.scrollUp - 3);
          this.renderContent();
          this.renderFooter();
        }
      } else if (key.name === 'pageup') {
        if (tab) {
          const contentRows = this.rows - this.headerLines - this.footerLines;
          const totalLines = this.getRenderedLines(tab).length;
          const maxScroll = Math.max(0, totalLines - contentRows);
          tab.scrollUp = Math.min(tab.scrollUp + contentRows, maxScroll);
          this.renderContent();
          this.renderFooter();
        }
      } else if (key.name === 'pagedown') {
        if (tab) {
          const contentRows = this.rows - this.headerLines - this.footerLines;
          tab.scrollUp = Math.max(0, tab.scrollUp - contentRows);
          this.renderContent();
          this.renderFooter();
        }
      } else if (key.name === 'q' && onQuit) {
        onQuit();
      } else if (_ch && _ch >= '1' && _ch <= '9') {
        const idx = parseInt(_ch, 10) - 1;
        if (idx < this.tabs.length) {
          this.activeTab = idx;
          this.render();
        }
      }
    };

    process.stdin.on('keypress', this.keypressHandler);
  }

  private stopListening(): void {
    if (this.keypressHandler) {
      process.stdin.removeListener('keypress', this.keypressHandler);
      this.keypressHandler = null;
    }
    this.listening = false;
    this.stopResize();
  }

  private rendering = false;
  private renderQueued = false;

  private render(): void {
    // Debounce: if a render is in progress, queue one more
    if (this.rendering) {
      this.renderQueued = true;
      return;
    }
    this.rendering = true;

    // Update terminal size
    this.rows = process.stderr.rows || 40;
    this.cols = process.stderr.columns || 80;

    process.stderr.write(HIDE_CURSOR);
    this.renderTabBar();
    this.renderContent();
    this.renderFooter();

    this.rendering = false;
    if (this.renderQueued) {
      this.renderQueued = false;
      // Use setImmediate to avoid stack overflow from rapid re-renders
      setImmediate(() => this.render());
    }
  }

  private renderTabBar(): void {
    process.stderr.write('\x1b[1;1H'); // Move to row 1

    const parts: string[] = [];
    for (let i = 0; i < this.tabs.length; i++) {
      const tab = this.tabs[i]!;
      const num = i + 1;
      const statusIcon = tab.status === 'streaming' ? '◉'
                       : tab.status === 'done' ? '✓'
                       : tab.status === 'failed' ? '✗'
                       : '○';
      const label = ` ${num}: ${tab.label} ${statusIcon} `;

      if (i === this.activeTab) {
        if (tab.status === 'failed') {
          parts.push(`${BG_FAIL}${label}${RESET}`);
        } else if (tab.status === 'done') {
          parts.push(`${BG_DONE}${label}${RESET}`);
        } else {
          parts.push(`${BG_ACTIVE}${label}${RESET}`);
        }
      } else {
        const dimLabel = tab.status === 'streaming' ? `${CYAN}${label}${RESET}`
                       : tab.status === 'failed' ? `${RED}${label}${RESET}`
                       : `${DIM}${label}${RESET}`;
        parts.push(dimLabel);
      }
    }

    process.stderr.write(`${CLEAR_LINE}${parts.join(' ')}`);
    process.stderr.write(`\n${CLEAR_LINE}${DIM}${'─'.repeat(this.cols)}${RESET}`);
  }

  private getRenderedLines(tab: TabState): string[] {
    const raw = tab.buffer || '';
    // Always render markdown (even while streaming) so wrap math sees the actual visible width.
    const rendered = tab.status === 'done' ? renderMarkdown(raw) : raw;
    const lines: string[] = [];
    for (const line of rendered.split('\n')) {
      if (visibleWidth(line) <= this.cols) {
        lines.push(line);
      } else {
        lines.push(...this.wrapLine(line, this.cols));
      }
    }
    return lines;
  }

  /**
   * Soft-wrap a single line to `width` display columns, preserving ANSI codes
   * and treating CJK/emoji as 2 columns. Empty inputs yield [''] so callers
   * still get a row to render.
   */
  private wrapLine(line: string, width: number): string[] {
    const result: string[] = [];
    let current = '';
    let visLen = 0;
    let inEscape = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '\x1b') {
        inEscape = true;
        current += ch;
        continue;
      }
      if (inEscape) {
        current += ch;
        if (ch === 'm') inEscape = false;
        continue;
      }

      const cw = charWidth(line, i);
      if (visLen + cw > width) {
        result.push(current);
        current = '';
        visLen = 0;
      }
      current += ch;
      // Surrogate pair: include the low surrogate as part of the same code point.
      if (cw === 2 && line.charCodeAt(i) >= 0xD800 && line.charCodeAt(i) <= 0xDBFF) {
        i++;
        if (i < line.length) current += line[i];
      }
      visLen += cw;
    }
    if (current) result.push(current);
    return result.length > 0 ? result : [''];
  }

  private renderContent(): void {
    const tab = this.tabs[this.activeTab];
    if (!tab) return;

    const contentRows = this.rows - this.headerLines - this.footerLines;
    const lines = this.getRenderedLines(tab);
    const totalLines = lines.length;

    // scrollUp=0 means pinned to bottom; scrollUp=N means N lines from bottom
    let startLine: number;
    if (tab.scrollUp === 0) {
      startLine = Math.max(0, totalLines - contentRows);
    } else {
      startLine = Math.max(0, totalLines - contentRows - tab.scrollUp);
    }
    const visibleLines = lines.slice(startLine, startLine + contentRows);

    // Move to content area start (row 3)
    for (let i = 0; i < contentRows; i++) {
      process.stderr.write(`\x1b[${this.headerLines + 1 + i};1H${CLEAR_LINE}`);
      if (i < visibleLines.length) {
        process.stderr.write(visibleLines[i]!);
      }
    }
  }

  private renderFooter(): void {
    const tab = this.tabs[this.activeTab];

    // Line 1: separator
    process.stderr.write(`\x1b[${this.rows - 2};1H`);
    process.stderr.write(`${CLEAR_LINE}${DIM}${'─'.repeat(this.cols)}${RESET}`);

    // Line 2: activity log (process status, non-intrusive)
    process.stderr.write(`\x1b[${this.rows - 1};1H`);
    const logText = this.activityLog.substring(0, this.cols - 2);
    process.stderr.write(`${CLEAR_LINE}${DIM} ${logText}${RESET}`);

    // Line 3: tab info + keybindings
    process.stderr.write(`\x1b[${this.rows};1H`);

    let status = '';
    if (tab) {
      // Find the agent for this tab to show model name
      const agentModel = tab.id.startsWith('__') ? '' : this.tabModels.get(tab.id) ?? '';
      const modelSuffix = agentModel ? ` (${agentModel})` : '';

      if (tab.elapsed) {
        status = `${tab.label}${modelSuffix} ${(tab.elapsed / 1000).toFixed(1)}s ${tab.mode ? '[' + tab.mode + ']' : ''}`;
      } else if (tab.status === 'streaming') {
        status = `${tab.label}${modelSuffix} streaming...`;
      } else if (tab.status === 'pending') {
        status = `${tab.label} waiting...`;
      }

      const totalLines = this.getRenderedLines(tab).length;
      const contentRows = this.rows - this.headerLines - this.footerLines;
      if (totalLines > contentRows) {
        const pct = tab.scrollUp === 0
          ? 100
          : Math.round((1 - tab.scrollUp / Math.max(1, totalLines - contentRows)) * 100);
        status += `  ${pct}%`;
        if (tab.scrollUp > 0) status += ' ↕';
      }
    }

    const n = this.tabs.length;
    process.stderr.write(
      `${CLEAR_LINE}${DIM} ${status}  │  ← → tabs  ↑ ↓ scroll  1-${n} jump  q exit${RESET}`,
    );
  }
}
