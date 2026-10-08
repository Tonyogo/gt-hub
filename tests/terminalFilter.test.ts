import { isSyntheticTerminalReport } from '../frontend/src/utils/terminalFilter';

describe('isSyntheticTerminalReport', () => {
  it('should identify CPR (Cursor Position Report)', () => {
    expect(isSyntheticTerminalReport('\x1b[24;80R')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[1;1R')).toBe(true);
  });

  it('should identify DA / DA2 (Device Attributes report)', () => {
    expect(isSyntheticTerminalReport('\x1b[>0;276;0c')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[?1;2c')).toBe(true);
  });

  it('should identify OSC 10 and OSC 11 color reports', () => {
    expect(isSyntheticTerminalReport('\x1b]10;rgb:f1f1/f5f5/f9f9\x1b\\')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b]11;rgb:0909/0a0a/0f0f\x1b\\')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b]10;rgb:ffff/ffff/ffff\x07')).toBe(true);
  });

  it('should identify DECRPM (DEC Report Mode)', () => {
    expect(isSyntheticTerminalReport('\x1b[12;2$y')).toBe(true);
    expect(isSyntheticTerminalReport('\x1b[?2004;1$y')).toBe(true);
  });

  it('should not match normal user typing or control keys', () => {
    expect(isSyntheticTerminalReport('i')).toBe(false);
    expect(isSyntheticTerminalReport('ls -la\r')).toBe(false);
    expect(isSyntheticTerminalReport('\x1b[A')).toBe(false); // Up arrow
    expect(isSyntheticTerminalReport('\x1b[B')).toBe(false); // Down arrow
    expect(isSyntheticTerminalReport('\x1b[C')).toBe(false); // Right arrow
    expect(isSyntheticTerminalReport('\x1b[D')).toBe(false); // Left arrow
    expect(isSyntheticTerminalReport('\x03')).toBe(false); // Ctrl+C
    expect(isSyntheticTerminalReport('\x1b')).toBe(false); // ESC
    expect(isSyntheticTerminalReport('\r')).toBe(false); // Enter
    expect(isSyntheticTerminalReport(':wq\r')).toBe(false);
  });
});
