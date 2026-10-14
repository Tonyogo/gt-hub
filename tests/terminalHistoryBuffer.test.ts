import { TerminalHistoryBuffer } from '../src/agent/pty/terminalHistoryBuffer';

describe('TerminalHistoryBuffer Unit Tests', () => {
  test('accumulates text chunks and reports correct size', () => {
    const buf = new TerminalHistoryBuffer(1024);
    expect(buf.getSize()).toBe(0);
    expect(buf.getString()).toBe('');

    buf.push('Hello ');
    buf.push(Buffer.from('World!\r\n'));
    expect(buf.getSize()).toBe(14);
    expect(buf.getString()).toBe('Hello World!\r\n');
  });

  test('evicts oldest data when capacity is exceeded', () => {
    const buf = new TerminalHistoryBuffer(20);
    buf.push('1234567890'); // 10 bytes
    buf.push('abcdefghij'); // 10 bytes -> total 20 bytes
    expect(buf.getSize()).toBe(20);
    expect(buf.getString()).toBe('1234567890abcdefghij');

    // Push 5 more bytes -> total 25, exceeds 20 by 5
    buf.push('KLMNO');
    expect(buf.getSize()).toBe(20);
    expect(buf.getString()).toBe('67890abcdefghijKLMNO');
  });

  test('truncates prior history when hardware reset (\\x1bc) is encountered', () => {
    const buf = new TerminalHistoryBuffer(1024);
    buf.push('Line 1: old history that will be cleared\r\n');
    buf.push('Line 2: more old history\r\n');
    expect(buf.getString()).toContain('Line 1');

    // Simulate reset
    buf.push('\x1bcLine 3: clean new history after reset');
    expect(buf.getString()).toBe('\x1bcLine 3: clean new history after reset');
    expect(buf.getString()).not.toContain('Line 1');
  });

  test('truncates prior history when scrollback clear (\\x1b[3J) is encountered', () => {
    const buf = new TerminalHistoryBuffer(1024);
    buf.push('Long obsolete terminal scrollback before clear command\r\n');
    expect(buf.getSize()).toBeGreaterThan(30);

    // Shell clear command output
    buf.push('\x1b[3J$ ls -la\r\n');
    expect(buf.getString()).toBe('\x1b[3J$ ls -la\r\n');
  });

  test('clear() empties the buffer', () => {
    const buf = new TerminalHistoryBuffer(1024);
    buf.push('Some output');
    expect(buf.getSize()).toBeGreaterThan(0);

    buf.clear();
    expect(buf.getSize()).toBe(0);
    expect(buf.getString()).toBe('');
    expect(buf.getBuffer().length).toBe(0);
  });

  test('getSanitizedString strips terminal queries', () => {
    const buf = new TerminalHistoryBuffer(1024);
    // Push terminal color query sequence OSC 10 / OSC 11
    buf.push('Output before query\x1b]10;?\x07Output after query');
    const sanitized = buf.getSanitizedString();
    expect(sanitized).not.toContain('\x1b]10;?\x07');
    expect(sanitized).toContain('Output before queryOutput after query');
  });
});
