const MOUSE_OR_FOCUS_MODES = new Set(['9', '1000', '1002', '1003', '1004', '1006', '1016']);
const ALT_SCREEN_MODES = new Set(['47', '1047', '1049']);

function hasTrailingIncompleteAnsiSequence(text: string): boolean {
  if (!text) return false;
  const searchStart = Math.max(0, text.length - 64);
  const lastEsc = text.lastIndexOf('\x1b');
  if (lastEsc === -1 || lastEsc < searchStart) return false;

  const remainder = text.slice(lastEsc);
  if (remainder === '\x1b') return true;
  if (remainder[1] === '[') {
    return /^\[[0-9;:?<>! "'*]*$/.test(remainder.slice(1));
  }
  if (remainder[1] === ']') {
    return !remainder.includes('\x07') && !remainder.includes('\x1b\\');
  }
  return false;
}

/**
 * Finds a safe split index <= maxChars that never cuts inside an ANSI escape sequence
 * or between a UTF-16 surrogate pair.
 */
export function findSafeAnsiSplitIndex(text: string, maxChars: number): number {
  if (!text || text.length <= maxChars) {
    return text ? text.length : 0;
  }
  let cut = maxChars;
  const candidate = text.slice(0, cut);
  if (hasTrailingIncompleteAnsiSequence(candidate)) {
    const lastEsc = candidate.lastIndexOf('\x1b');
    if (lastEsc > 0) {
      cut = lastEsc;
    }
  }
  if (cut > 0) {
    const prevCode = text.charCodeAt(cut - 1);
    if (prevCode >= 0xd800 && prevCode <= 0xdbff) {
      cut -= 1;
    }
  }
  return cut > 0 ? cut : maxChars;
}

/**
 * Utility to sanitize terminal streams before replaying historical scrollback.
 * Strips terminal query escape sequences
 * (such as OSC 10/11 color queries, DA device attribute queries, CPR cursor requests)
 * to prevent attached xterm.js clients from generating synthetic response reports back into the shell.
 */
export function stripTerminalQuerySequences(stream: string): string {
  if (!stream || typeof stream !== 'string') return '';
  let stripped = stream.replace(
    /\x1b(?:\](?:4|10|11|12);\?(?:\x1b\\|\x07)|\[[>?=]?(?:0)?c|\[\??6n|\[\??\d+\$p|\[>0?q|\[(?:14|18|19|20|21)t)/g,
    ''
  );
  if (!stripped) return '';

  // Neutralize unclosed mouse tracking or focus modes when replayed stream ends in normal buffer mode
  let inAlt = false;
  const activeMouseOrFocus = new Set<string>();
  const modeRe = /\x1b\[\?([0-9;]+)([hl])|\x1bc/g;
  let match: RegExpExecArray | null = null;
  while ((match = modeRe.exec(stripped)) !== null) {
    if (match[0] === '\x1bc') {
      inAlt = false;
      activeMouseOrFocus.clear();
      continue;
    }
    const action = match[2];
    const params = match[1].split(';');
    for (const p of params) {
      if (ALT_SCREEN_MODES.has(p)) {
        inAlt = action === 'h';
      } else if (MOUSE_OR_FOCUS_MODES.has(p)) {
        if (action === 'h') {
          activeMouseOrFocus.add(p);
        } else {
          activeMouseOrFocus.delete(p);
        }
      }
    }
  }

  if (!inAlt && activeMouseOrFocus.size > 0) {
    stripped += '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l';
  }

  // Prepend soft style reset and show cursor to ensure pristine state after replay
  return '\x1b[0m\x1b[?25h' + stripped;
}
