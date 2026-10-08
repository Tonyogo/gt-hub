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
 * (OSC 4/10/11/12, DA, DECRPM) that should never be echoed to a standard shell prompt.
 */
export function isUnsolicitedShellDeviceReport(data: string): boolean {
  if (!data || typeof data !== 'string') {
    return false;
  }
  const stripped = data.replace(
    /\x1b(?:\[[>?=]\d+(?:;\d+)*c|\](?:4|10|11|12);[^\x1b\x07]+(?:\x1b\\|\x07)|\[\??\d+(?:;\d+)*\$y)/g,
    ''
  );
  return stripped.length === 0;
}
