import * as fs from 'fs';
import * as path from 'path';
import { TerminalHistoryBuffer } from '../src/agent/pty/terminalHistoryBuffer';

describe('Terminal Claude Code In-Session Scrollback & Alternate Wheel Navigation', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  let webTerminalContent: string;

  beforeAll(() => {
    webTerminalContent = fs.readFileSync(webTerminalPath, 'utf-8');
  });

  it('preserves real conversation lines when high-frequency in-place TUI redraw frames (ESC[H ESC[2K) are pushed', () => {
    // Buffer with small maxLines = 5 for test verification
    const buf = new TerminalHistoryBuffer(1024 * 1024, true, 5);

    // Push 3 lines of real user dialogue
    buf.push('User: Hello Claude\r\n');
    buf.push('Claude: Thinking...\r\n');
    buf.push('Claude: Here is the code solution\r\n');

    // Simulate Claude Code / Ink sending 50 in-place redraw frames (with 40 newlines each)
    const redrawFrame = '\x1b[H\x1b[2Krow1\r\n\x1b[2Krow2\r\n\x1b[2Krow3\r\n\x1b[2K\x1b[1B';
    for (let i = 0; i < 50; i++) {
      buf.push(redrawFrame);
    }

    const output = buf.getString();
    // Real conversation lines must still be present and NOT evicted by in-place redraw newlines!
    expect(output).toContain('User: Hello Claude');
    expect(output).toContain('Claude: Thinking...');
    expect(output).toContain('Claude: Here is the code solution');
  });

  it('WebTerminalView registers custom wheel handler forwarding PageUp and PageDown in alternate screen buffer', () => {
    expect(webTerminalContent).toContain('attachCustomWheelEventHandler');
    expect(webTerminalContent).toContain("term.buffer.active.type === 'alternate'");
    expect(webTerminalContent).toContain('\\x1b[5~'); // PageUp
    expect(webTerminalContent).toContain('\\x1b[6~'); // PageDown
  });

  it('WebTerminalView maps mobile touch scroll to PageUp/PageDown when in alternate screen buffer', () => {
    const applyScrollDeltaIdx = webTerminalContent.indexOf('const applyScrollDelta =');
    const applyScrollDeltaBlock = webTerminalContent.slice(applyScrollDeltaIdx, applyScrollDeltaIdx + 1000);
    expect(applyScrollDeltaBlock).toContain("term.buffer?.active?.type === 'alternate'");
    expect(applyScrollDeltaBlock).toContain('\\x1b[5~');
    expect(applyScrollDeltaBlock).toContain('\\x1b[6~');
  });

  it('WebTerminalView onData does not unconditionally force scrollToBottomSafe when user is scrolled up', () => {
    const onDataIdx = webTerminalContent.indexOf('term.onData((data) => {');
    const onDataBlock = webTerminalContent.slice(onDataIdx, onDataIdx + 1200);
    expect(onDataBlock).toContain("data === '\\r' || data === '\\n' || isAtBottomRef.current");
  });

  it('WebTerminalView provides 10000 default scrollback lines for extensive transcripts', () => {
    expect(webTerminalContent).toContain('defaultScrollback = 10000');
  });
});
