import fs from 'fs';
import path from 'path';
import {
  normalizeTerminalLogText,
  stripAnsiCodes,
  parseAnsiToSegments,
} from '../frontend/src/utils/ansiLogFormatter';

describe('ANSI Log Formatter & Control Sequence Sanitizer', () => {
  test('normalizeTerminalLogText resolves carriage return (\\r) progress overwrites and strips private CSI/OSC codes', () => {
    const raw = '\x1b[?25lProgress: 10%\rProgress: 55%\rProgress: 100%\r\n\x1b[2K\x1b[?25hDone!';
    const normalized = normalizeTerminalLogText(raw);
    expect(normalized).toBe('Progress: 100%\nDone!');
    expect(normalized).not.toContain('\x1b');
  });

  test('stripAnsiCodes removes all SGR color sequences for clean clipboard copy', () => {
    const raw = '\x1b[1;32m[SUCCESS]\x1b[0m Task completed in \x1b[33m1.2s\x1b[0m';
    expect(stripAnsiCodes(raw)).toBe('[SUCCESS] Task completed in 1.2s');
  });

  test('parseAnsiToSegments converts SGR colors and bold flags into styled segments', () => {
    const raw = '\x1b[1;32mPASS\x1b[0m \x1b[31mFAIL\x1b[0m plain';
    const segments = parseAnsiToSegments(raw);

    expect(segments).toEqual([
      { text: 'PASS', colorClass: 'text-emerald-400', bold: true },
      { text: ' ', colorClass: undefined, bold: false },
      { text: 'FAIL', colorClass: 'text-rose-400', bold: false },
      { text: ' plain', colorClass: undefined, bold: false },
    ]);
  });

  test('TaskLogModal and CronLogModal wire parseAnsiToSegments and stripAnsiCodes', () => {
    const taskModalCode = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/terminal/components/TaskLogModal.tsx'),
      'utf-8'
    );
    const cronModalCode = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/terminal/components/CronLogModal.tsx'),
      'utf-8'
    );

    expect(taskModalCode).toContain('parseAnsiToSegments');
    expect(taskModalCode).toContain('stripAnsiCodes');
    expect(cronModalCode).toContain('parseAnsiToSegments');
    expect(cronModalCode).toContain('stripAnsiCodes');
  });
});
