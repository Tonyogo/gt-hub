/**
 * Utility to sanitize terminal streams before replaying historical scrollback.
 * Strips terminal query escape sequences
 * (such as OSC 10/11 color queries, DA device attribute queries, CPR cursor requests)
 * to prevent attached xterm.js clients from generating synthetic response reports back into the shell.
 */
export function stripTerminalQuerySequences(stream: string): string {
  if (!stream || typeof stream !== 'string') return '';
  const stripped = stream.replace(
    /\x1b(?:\](?:4|10|11|12);\?(?:\x1b\\|\x07)|\[[>?=]?(?:0)?c|\[\??6n|\[\??\d+\$p|\[>0?q|\[(?:14|18|19|20|21)t)/g,
    ''
  );
  if (!stripped) return '';
  // Prepend soft style reset and show cursor to ensure pristine state after replay
  return '\x1b[0m\x1b[?25h' + stripped;
}
