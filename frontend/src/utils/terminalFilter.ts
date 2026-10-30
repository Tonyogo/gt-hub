/**
 * Detects whether an escape sequence produced by xterm.js onData is an
 * automated device response / report generated in response to historical query sequences.
 * Supports both standalone single reports and compound / concatenated reports.
 */
export function isSyntheticTerminalReport(data: string): boolean {
  if (!data || typeof data !== 'string') {
    return false;
  }

  // Token regex for all standard automated terminal reports:
  // 1. CPR: \x1b[\??\d+(?:;\d+)*R
  // 2. DA / DA2 / DA3: \x1b[[>?=]\d+(?:;\d+)*c
  // 3. OSC 4/10/11/12 color reports: \x1b](?:4|10|11|12);[^\x1b\x07]+(?:\x1b\\|\x07)
  // 4. DECRPM / ANSI mode reports: \x1b[\??\d+(?:;\d+)*\$y
  // 5. Window manipulation reports: \x1b[\d+(?:;\d+)*t
  const stripped = data.replace(
    /\x1b(?:\[\??\d+(?:;\d+)*R|\[[>?=]\d+(?:;\d+)*c|\](?:4|10|11|12);[^\x1b\x07]+(?:\x1b\\|\x07)|\[\??\d+(?:;\d+)*\$y|\[\d+(?:;\d+)*t)/g,
    ''
  );

  return stripped.length === 0;
}

/**
 * Detects whether data contains any unsolicited color or device attribute reports
 * (OSC 4/10/11/12, DA), mouse reports (SGR 1006, legacy X10/VT200),
 * or focus reports (1004) that should never be echoed to a standard shell prompt.
 *
 * NOTE: DECRPM (\x1b[?...$y) responses are intentionally NOT filtered here because
 * interactive CLI and TUI tools (such as Claude Code and agy) probe terminal capabilities
 * (e.g. DEC Mode 2026 Synchronized Output via \x1b[?2026$p) while running in normal buffer mode.
 * Blocking DECRPM prevents these tools from negotiating flicker-free synchronized rendering.
 */
export function isUnsolicitedShellDeviceReport(data: string): boolean {
  if (!data || typeof data !== 'string') {
    return false;
  }
  const stripped = data.replace(
    /\x1b(?:\[[>?=]\d+(?:;\d+)*c|\](?:4|10|11|12);[^\x1b\x07]+(?:\x1b\\|\x07)|\[<\d+;\d+;\d+[Mm]|\[M[\s\S]{3}|\[[IO])/g,
    ''
  );
  return stripped.length === 0;
}

/**
 * Tracks whether the remote terminal stream has switched into or out of
 * alternate screen buffer mode (DECSET/DECRST 1049, 1047, or 47).
 * This inspects incoming stream frames immediately on arrival, avoiding
 * asynchronous queue latency (such as TerminalWriteScheduler) for wheel/touch event gating.
 */
export function updateRemoteAltScreenState(prevInAltScreen: boolean, chunk: string): boolean {
  if (!chunk || typeof chunk !== 'string' || !chunk.includes('\x1b[?')) {
    return prevInAltScreen;
  }
  const regex = /\x1b\[\?(?:1049|1047|47)([hl])/g;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(chunk)) !== null) {
    lastMatch = match;
  }
  if (lastMatch) {
    return lastMatch[1] === 'h';
  }
  return prevInAltScreen;
}

