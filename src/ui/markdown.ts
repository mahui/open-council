/**
 * Lightweight Markdown → ANSI terminal renderer.
 * Handles common patterns without external dependencies.
 */

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const ITALIC = '\x1b[3m';
const UNDERLINE = '\x1b[4m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const GREEN = '\x1b[32m';
const MAGENTA = '\x1b[35m';
const RESET = '\x1b[0m';
const BG_DIM = '\x1b[48;5;236m';

export function renderMarkdown(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeBlockLang = '';

  for (const line of lines) {
    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockLang = line.trimStart().slice(3).trim();
        out.push(`  ${DIM}┌─${codeBlockLang ? ` ${codeBlockLang} ` : ''}${'─'.repeat(Math.max(0, 40 - (codeBlockLang.length + 3)))}${RESET}`);
      } else {
        inCodeBlock = false;
        codeBlockLang = '';
        out.push(`  ${DIM}└${'─'.repeat(40)}${RESET}`);
      }
      continue;
    }

    if (inCodeBlock) {
      out.push(`  ${DIM}│${RESET} ${CYAN}${line}${RESET}`);
      continue;
    }

    out.push(renderLine(line));
  }

  return out.join('\n');
}

function renderLine(line: string): string {
  const trimmed = line.trimStart();
  const indent = line.length - trimmed.length;
  const pad = ' '.repeat(indent);

  // Headers
  if (trimmed.startsWith('#### ')) return `${pad}${BOLD}${trimmed.slice(5)}${RESET}`;
  if (trimmed.startsWith('### ')) return `\n${pad}${BOLD}${trimmed.slice(4)}${RESET}`;
  if (trimmed.startsWith('## ')) return `\n${pad}${BOLD}${UNDERLINE}${trimmed.slice(3)}${RESET}`;
  if (trimmed.startsWith('# ')) return `\n${pad}${BOLD}${UNDERLINE}${trimmed.slice(2)}${RESET}\n`;

  // Horizontal rule
  if (/^[-*_]{3,}\s*$/.test(trimmed)) return `${pad}${DIM}${'─'.repeat(40)}${RESET}`;

  // Table rows — keep structure, dim separators
  if (trimmed.startsWith('|')) {
    if (/^\|[\s-:|]+\|$/.test(trimmed)) {
      // Separator row
      return `${pad}${DIM}${trimmed}${RESET}`;
    }
    return `${pad}${renderInline(trimmed)}`;
  }

  // Unordered list
  if (/^[-*+] /.test(trimmed)) {
    return `${pad}  • ${renderInline(trimmed.slice(2))}`;
  }

  // Ordered list
  const olMatch = trimmed.match(/^(\d+)\.\s+(.*)$/);
  if (olMatch) {
    return `${pad}  ${DIM}${olMatch[1]}.${RESET} ${renderInline(olMatch[2]!)}`;
  }

  // Blockquote
  if (trimmed.startsWith('> ')) {
    return `${pad}  ${DIM}│${RESET} ${ITALIC}${renderInline(trimmed.slice(2))}${RESET}`;
  }

  // Normal paragraph
  return `${pad}${renderInline(trimmed)}`;
}

function renderInline(text: string): string {
  return text
    // Bold + italic
    .replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD}${ITALIC}$1${RESET}`)
    // Bold
    .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`)
    // Italic
    .replace(/\*(.+?)\*/g, `${ITALIC}$1${RESET}`)
    // Inline code
    .replace(/`([^`]+)`/g, `${CYAN}$1${RESET}`)
    // Links [text](url) → text (dim url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${UNDERLINE}$1${RESET} ${DIM}($2)${RESET}`)
    // Strikethrough
    .replace(/~~(.+?)~~/g, `${DIM}$1${RESET}`);
}
