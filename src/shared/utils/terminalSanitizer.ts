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
  const hasMouseOrFocus = /\x1b\[\?(?:1000|1002|1003|1004|1006)h/.test(stripped);
  if (hasMouseOrFocus) {
    const endsInAlt = /\x1b\[\?(?:1049|1047|47)h(?![\s\S]*\x1b\[\?(?:1049|1047|47)l)/.test(stripped);
    if (!endsInAlt) {
      stripped += '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l';
    }
  }

  // Prepend soft style reset and show cursor to ensure pristine state after replay
  return '\x1b[0m\x1b[?25h' + stripped;
}
