/**
 * Inline slash command picker — Claude Code style.
 * Shows a filterable, arrow-navigable menu when user types /.
 */

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const BG_HIGHLIGHT = '\x1b[46m\x1b[30m'; // cyan bg, black text
const CLEAR_LINE = '\x1b[2K';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

export interface SlashCommand {
  name: string;
  args?: string;
  desc: string;
}

export interface PickerResult {
  /** The selected command (without /), or null if dismissed */
  command: string | null;
}

/**
 * Show an interactive slash command picker.
 * Takes over stdin, renders a navigable list, returns selected command.
 */
export function showSlashPicker(
  commands: SlashCommand[],
  promptPrefix: string,
): Promise<PickerResult> {
  return new Promise((resolve) => {
    let filter = '';
    let selectedIndex = 0;
    let filtered = commands;

    const cols = process.stderr.columns || 80;

    const updateFilter = () => {
      filtered = commands.filter(c =>
        c.name.toLowerCase().includes(filter.toLowerCase()),
      );
      if (selectedIndex >= filtered.length) {
        selectedIndex = Math.max(0, filtered.length - 1);
      }
    };

    const render = () => {
      // Clear menu area: move up to erase previous render, then redraw
      // First, clear all menu lines from previous render
      const menuLines = Math.min(filtered.length, 8);

      // Move to menu start (below prompt line) and clear
      for (let i = 0; i < menuLines + 1; i++) {
        process.stderr.write(`${CLEAR_LINE}\n`);
      }
      // Move back up
      process.stderr.write(`\x1b[${menuLines + 1}A`);

      // Redraw prompt line with current filter
      process.stderr.write(`${CLEAR_LINE}\r${promptPrefix}/${filter}`);

      // Draw menu below
      if (filtered.length === 0) {
        process.stderr.write(`\n${CLEAR_LINE}  ${DIM}No matching commands${RESET}`);
        process.stderr.write(`\n${CLEAR_LINE}`); // extra blank to clear leftover
        // Move cursor back to prompt line
        process.stderr.write(`\x1b[2A\r${promptPrefix}/${filter}`);
        return;
      }

      const visible = filtered.slice(0, 8);
      for (let i = 0; i < visible.length; i++) {
        const cmd = visible[i]!;
        const isSelected = i === selectedIndex;
        const argStr = cmd.args ? ` ${cmd.args}` : '';

        if (isSelected) {
          process.stderr.write(
            `\n${CLEAR_LINE}  ${BG_HIGHLIGHT} ${cmd.name}${argStr} ${RESET} ${DIM}${cmd.desc}${RESET}`,
          );
        } else {
          process.stderr.write(
            `\n${CLEAR_LINE}  ${CYAN}${cmd.name}${RESET}${DIM}${argStr}  ${cmd.desc}${RESET}`,
          );
        }
      }

      // Clear any remaining old lines
      process.stderr.write(`\n${CLEAR_LINE}`);

      // Move cursor back to prompt
      process.stderr.write(`\x1b[${visible.length + 1}A\r${promptPrefix}/${filter}`);
    };

    const cleanup = () => {
      // Clear the menu
      const menuLines = Math.min(filtered.length, 8) + 1;
      for (let i = 0; i < menuLines; i++) {
        process.stderr.write(`\n${CLEAR_LINE}`);
      }
      // Move back to prompt line
      process.stderr.write(`\x1b[${menuLines}A`);
      process.stderr.write(`${CLEAR_LINE}\r`);
      process.stderr.write(SHOW_CURSOR);

      process.stdin.removeListener('data', onData);
      // Don't touch rawMode/pause — caller (input.ts) manages stdin lifecycle
    };

    const onData = (data: Buffer | string) => {
      const key = typeof data === 'string' ? data : data.toString('utf-8');

      // Escape → dismiss
      if (key === '\x1b' && key.length === 1) {
        cleanup();
        resolve({ command: null });
        return;
      }

      // Ctrl-C → dismiss
      if (key === '\x03') {
        cleanup();
        resolve({ command: null });
        return;
      }

      // Enter → select
      if (key === '\r' || key === '\n') {
        const selected = filtered[selectedIndex];
        cleanup();
        if (selected) {
          resolve({ command: selected.name.slice(1) }); // remove leading /
        } else {
          resolve({ command: null });
        }
        return;
      }

      // Tab → select (same as Enter)
      if (key === '\t') {
        const selected = filtered[selectedIndex];
        cleanup();
        if (selected) {
          resolve({ command: selected.name.slice(1) });
        } else {
          resolve({ command: null });
        }
        return;
      }

      // Arrow up
      if (key === '\x1b[A') {
        selectedIndex = Math.max(0, selectedIndex - 1);
        render();
        return;
      }

      // Arrow down
      if (key === '\x1b[B') {
        selectedIndex = Math.min(filtered.length - 1, selectedIndex + 1);
        render();
        return;
      }

      // Backspace
      if (key === '\x7f' || key === '\b') {
        if (filter.length > 0) {
          filter = filter.slice(0, -1);
          updateFilter();
          render();
        } else {
          // Backspace on empty filter → dismiss (erasing the /)
          cleanup();
          resolve({ command: null });
        }
        return;
      }

      // Space after selection → select and append space for args
      if (key === ' ' && filtered[selectedIndex]) {
        const selected = filtered[selectedIndex];
        cleanup();
        resolve({ command: selected!.name.slice(1) });
        return;
      }

      // Regular character → add to filter
      if (key.length === 1 && key >= ' ') {
        filter += key;
        updateFilter();
        render();
        return;
      }
    };

    // Take over stdin (already in raw mode from input.ts, just attach listener)
    process.stderr.write(HIDE_CURSOR);
    if (!process.stdin.isRaw) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    }
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', onData);

    // Initial render
    render();
  });
}
