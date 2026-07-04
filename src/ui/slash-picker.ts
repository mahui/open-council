/**
 * Inline slash command picker — Claude Code style.
 * Shows a filterable, arrow-navigable menu when user types /.
 */

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const BG_HIGHLIGHT = '\x1b[46m\x1b[30m'; // cyan bg, black text
const CLEAR_LINE = '\x1b[2K';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/** Truncate an ANSI-bearing string to fit within `width` visible columns,
 *  appending "…" + RESET when cut. Treats CJK/emoji as 2 columns. */
function truncateAnsi(text: string, width: number): string {
  if (width <= 1) return '';
  let visCount = 0;
  let out = '';
  let inEsc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '\x1b') { inEsc = true; out += ch; continue; }
    if (inEsc) { out += ch; if (ch === 'm') inEsc = false; continue; }
    const code = text.charCodeAt(i);
    let w = 1;
    if (code >= 0xD800 && code <= 0xDBFF) w = 2;
    else if (
      (code >= 0x1100 && code <= 0x115F) ||
      (code >= 0x2E80 && code <= 0x303E) ||
      (code >= 0x3040 && code <= 0x33BF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x4E00 && code <= 0xA4CF) ||
      (code >= 0xAC00 && code <= 0xD7AF) ||
      (code >= 0xFF01 && code <= 0xFF60)
    ) w = 2;

    if (visCount + w > width - 1) {
      return out + '\x1b[0m\u2026';
    }
    out += ch;
    if (w === 2 && code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      out += text[i + 1];
      i++;
    }
    visCount += w;
  }
  return out + '\x1b[0m';
}

function formatRow(cmd: SlashCommand, isSelected: boolean, cols: number): string {
  const argStr = cmd.args ? ` ${cmd.args}` : '';
  const raw = isSelected
    ? `  ${BG_HIGHLIGHT} ${cmd.name}${argStr} ${RESET} ${DIM}${cmd.desc}${RESET}`
    : `  ${CYAN}${cmd.name}${RESET}${DIM}${argStr}  ${cmd.desc}${RESET}`;
  return truncateAnsi(raw, cols);
}

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

    const MENU_HEIGHT = 8;
    let reserved = false;

    const updateFilter = () => {
      filtered = commands.filter(c =>
        c.name.toLowerCase().includes(filter.toLowerCase()),
      );
      if (selectedIndex >= filtered.length) {
        selectedIndex = Math.max(0, filtered.length - 1);
      }
    };

    /** Reserve MENU_HEIGHT blank lines below the prompt once, so subsequent
     *  renders never trigger terminal scroll (which would invalidate cursor math). */
    const reserveSpace = () => {
      if (reserved) return;
      reserved = true;
      process.stderr.write('\n'.repeat(MENU_HEIGHT));
      process.stderr.write(`\x1b[${MENU_HEIGHT}A`);
    };

    const render = () => {
      reserveSpace();
      const cols = (process.stderr.columns || 80);

      // Redraw prompt line first.
      process.stderr.write(`\r${CLEAR_LINE}${promptPrefix}/${filter}`);

      const visible = filtered.slice(0, MENU_HEIGHT);

      // Always paint MENU_HEIGHT lines (even if blank) so stale rows from a
      // previous render with more matches get fully erased.
      for (let i = 0; i < MENU_HEIGHT; i++) {
        process.stderr.write(`\n${CLEAR_LINE}`);
        if (i < visible.length) {
          process.stderr.write(formatRow(visible[i]!, i === selectedIndex, cols));
        } else if (i === 0 && visible.length === 0) {
          process.stderr.write(`  ${DIM}No matching commands${RESET}`);
        }
      }

      // Move cursor back up to the prompt line and reposition at end of input.
      process.stderr.write(`\x1b[${MENU_HEIGHT}A\r${promptPrefix}/${filter}`);
    };

    const cleanup = () => {
      if (reserved) {
        // Erase the MENU_HEIGHT rows we own, then restore cursor to prompt line.
        for (let i = 0; i < MENU_HEIGHT; i++) {
          process.stderr.write(`\n${CLEAR_LINE}`);
        }
        process.stderr.write(`\x1b[${MENU_HEIGHT}A\r${CLEAR_LINE}`);
      }
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
