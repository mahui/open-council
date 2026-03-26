/**
 * Custom line input with immediate slash interception.
 * Supports multi-line wrapping, CJK wide characters, and ANSI prompts.
 */

import { emitKeypressEvents } from 'node:readline';

const CLEAR_LINE = '\x1b[2K';

/** Get display width of a string (CJK = 2, ANSI codes = 0, others = 1) */
function displayWidth(str: string): number {
  let w = 0;
  let inEscape = false;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)!;
    if (str[i] === '\x1b') { inEscape = true; continue; }
    if (inEscape) { if (str[i] === 'm') inEscape = false; continue; }
    // Surrogate pair (emoji etc)
    if (code >= 0xD800 && code <= 0xDBFF) { w += 2; i++; continue; }
    // CJK Unified Ideographs and common wide ranges
    if (
      (code >= 0x1100 && code <= 0x115F) ||  // Hangul Jamo
      (code >= 0x2E80 && code <= 0x303E) ||  // CJK Radicals
      (code >= 0x3040 && code <= 0x33BF) ||  // Hiragana, Katakana, CJK
      (code >= 0x3400 && code <= 0x4DBF) ||  // CJK Unified Extension A
      (code >= 0x4E00 && code <= 0xA4CF) ||  // CJK Unified / Yi
      (code >= 0xAC00 && code <= 0xD7AF) ||  // Hangul Syllables
      (code >= 0xF900 && code <= 0xFAFF) ||  // CJK Compatibility
      (code >= 0xFE30 && code <= 0xFE4F) ||  // CJK Compatibility Forms
      (code >= 0xFF01 && code <= 0xFF60) ||  // Fullwidth Forms
      (code >= 0xFFE0 && code <= 0xFFE6)     // Fullwidth Signs
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/** Get display width of the line up to character index `pos` */
function widthUpTo(str: string, pos: number): number {
  return displayWidth(str.substring(0, pos));
}

export interface InputOptions {
  prompt: string;
  onSlash: () => Promise<void>;
  onLine: (line: string) => Promise<void>;
  onClose: () => void;
}

export function startInput(opts: InputOptions): { close: () => void } {
  const { prompt, onSlash, onLine, onClose } = opts;
  let line = '';
  let cursor = 0; // character index in `line`
  let active = true;
  let busy = false;
  const history: string[] = [];
  let historyIndex = -1;
  let prevPhysicalRows = 1;

  const cols = () => process.stderr.columns || 80;
  const promptWidth = displayWidth(prompt);

  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf-8');

  const redraw = () => {
    const termCols = cols();
    const lineWidth = displayWidth(line);
    const totalWidth = promptWidth + lineWidth;
    const newPhysicalRows = Math.max(1, Math.ceil(totalWidth / termCols) || 1);

    // 1. Clear all previously occupied rows
    if (prevPhysicalRows > 1) {
      process.stderr.write(`\x1b[${prevPhysicalRows - 1}A`);
    }
    for (let i = 0; i < prevPhysicalRows; i++) {
      process.stderr.write(CLEAR_LINE);
      if (i < prevPhysicalRows - 1) process.stderr.write('\n');
    }
    if (prevPhysicalRows > 1) {
      process.stderr.write(`\x1b[${prevPhysicalRows - 1}A`);
    }

    // 2. Write full content
    process.stderr.write(`\r${prompt}${line}`);

    // 3. Position cursor correctly
    const cursorWidth = promptWidth + widthUpTo(line, cursor); // display columns to cursor
    const cursorRow = Math.floor(cursorWidth / termCols);
    const cursorCol = cursorWidth % termCols;
    const endWidth = totalWidth > 0 ? totalWidth : 1;
    const endRow = Math.floor((endWidth - 1) / termCols);

    // Move from end to cursor
    const rowDiff = endRow - cursorRow;
    if (rowDiff > 0) process.stderr.write(`\x1b[${rowDiff}A`);
    process.stderr.write('\r');
    if (cursorCol > 0) process.stderr.write(`\x1b[${cursorCol}C`);

    prevPhysicalRows = newPhysicalRows;
  };

  const showPrompt = () => {
    line = '';
    cursor = 0;
    historyIndex = -1;
    prevPhysicalRows = 1;
    process.stderr.write(`\r${CLEAR_LINE}${prompt}`);
  };

  const onKeypress = async (
    _ch: string | undefined,
    key: { name?: string; ctrl?: boolean; meta?: boolean; shift?: boolean; sequence?: string } | undefined,
  ) => {
    if (!active || busy) return;
    const ch = _ch ?? key?.sequence ?? '';

    // Ctrl-C
    if (key?.ctrl && key.name === 'c') {
      process.stderr.write('\n'); cleanup(); onClose(); return;
    }
    // Ctrl-D on empty
    if (key?.ctrl && key.name === 'd' && line.length === 0) {
      process.stderr.write('\n'); cleanup(); onClose(); return;
    }

    // '/' as first character → picker
    if (ch === '/' && line.length === 0) {
      busy = true; await onSlash(); busy = false; showPrompt(); return;
    }

    // Enter
    if (key?.name === 'return') {
      // Move cursor to end of content then newline
      const totalWidth = promptWidth + displayWidth(line);
      const termCols = cols();
      const endRow = Math.floor(Math.max(0, totalWidth - 1) / termCols);
      const cursorWidth = promptWidth + widthUpTo(line, cursor);
      const cursorRow = Math.floor(cursorWidth / termCols);
      const below = endRow - cursorRow;
      if (below > 0) process.stderr.write(`\x1b[${below}B`);
      process.stderr.write('\n');

      const input = line.trim();
      if (input) { history.unshift(input); if (history.length > 100) history.pop(); }
      line = ''; cursor = 0; prevPhysicalRows = 1;

      if (input) { busy = true; await onLine(input); busy = false; }
      showPrompt(); return;
    }

    // Backspace
    if (key?.name === 'backspace') {
      if (cursor > 0) {
        line = line.slice(0, cursor - 1) + line.slice(cursor);
        cursor--;
        redraw();
      }
      return;
    }
    // Delete
    if (key?.name === 'delete') {
      if (cursor < line.length) {
        line = line.slice(0, cursor) + line.slice(cursor + 1);
        redraw();
      }
      return;
    }
    // Left
    if (key?.name === 'left') { if (cursor > 0) { cursor--; redraw(); } return; }
    // Right
    if (key?.name === 'right') { if (cursor < line.length) { cursor++; redraw(); } return; }
    // Home / Ctrl-A
    if (key?.name === 'home' || (key?.ctrl && key.name === 'a')) { cursor = 0; redraw(); return; }
    // End / Ctrl-E
    if (key?.name === 'end' || (key?.ctrl && key.name === 'e')) { cursor = line.length; redraw(); return; }

    // Up → history
    if (key?.name === 'up') {
      if (historyIndex < history.length - 1) {
        historyIndex++; line = history[historyIndex]!; cursor = line.length; redraw();
      }
      return;
    }
    // Down → history
    if (key?.name === 'down') {
      if (historyIndex > 0) { historyIndex--; line = history[historyIndex]!; cursor = line.length; }
      else if (historyIndex === 0) { historyIndex = -1; line = ''; cursor = 0; }
      redraw(); return;
    }

    // Ctrl-U clear line
    if (key?.ctrl && key.name === 'u') { line = ''; cursor = 0; redraw(); return; }
    // Ctrl-W delete word
    if (key?.ctrl && key.name === 'w') {
      const before = line.slice(0, cursor);
      const after = line.slice(cursor);
      const trimmed = before.replace(/\S+\s*$/, '');
      line = trimmed + after; cursor = trimmed.length; redraw(); return;
    }

    // Regular printable character
    if (ch.length >= 1 && ch >= ' ' && !key?.ctrl && !key?.meta) {
      line = line.slice(0, cursor) + ch + line.slice(cursor);
      cursor += ch.length;
      redraw();
      return;
    }
  };

  process.stdin.on('keypress', onKeypress);

  const cleanup = () => {
    active = false;
    process.stdin.removeListener('keypress', onKeypress);
    try { process.stdin.setRawMode(false); process.stdin.pause(); } catch { /* */ }
  };

  showPrompt();

  return { close: () => { cleanup(); onClose(); } };
}
