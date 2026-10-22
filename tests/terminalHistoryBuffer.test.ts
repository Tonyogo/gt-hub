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

  test('isolates alternate screen (\\x1b[?1049h ... \\x1b[?1049l) redraw floods and preserves normal shell history on exit', () => {
    const buf = new TerminalHistoryBuffer(1024);
    buf.push('$ echo "important shell history before claude"\r\nimportant shell history before claude\r\n');

    // Enter alternate screen and flood 5000 bytes of TUI redraw frames (exceeding 1024 maxBytes)
    buf.push('\x1b[?1049h');
    for (let i = 0; i < 50; i++) {
      buf.push(`\x1b[H\x1b[2JClaude Code TUI frame #${i} - ${'x'.repeat(80)}\r\n`);
    }

    // While still in alternate screen, normal history + \x1b[?1049h header must still be preserved!
    const whileInAlt = buf.getString();
    expect(whileInAlt).toContain('important shell history before claude');
    expect(whileInAlt).toContain('\x1b[?1049h');
    expect(whileInAlt).toContain('Claude Code TUI frame #49');

    // Exit alternate screen -> all transient TUI frames are discarded and normal history remains intact
    buf.push('\x1b[?1049l$ echo "after claude exit"\r\n');
    const afterExit = buf.getString();
    expect(afterExit).toContain('important shell history before claude');
    expect(afterExit).toContain('$ echo "after claude exit"');
    expect(afterExit).not.toContain('Claude Code TUI frame');
    expect(afterExit).not.toContain('\x1b[?1049h');
  });
});
