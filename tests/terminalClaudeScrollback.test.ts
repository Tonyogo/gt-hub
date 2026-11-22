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

  it('WebTerminalView registers custom wheel handler using stepAlternateScreenScroll in alternate screen buffer', () => {
    expect(webTerminalContent).toContain('attachCustomWheelEventHandler');
    expect(webTerminalContent).toContain("term.buffer.active.type === 'alternate'");
    const wheelHandlerIdx = webTerminalContent.indexOf('term.attachCustomWheelEventHandler');
    const wheelHandlerBlock = webTerminalContent.slice(wheelHandlerIdx, wheelHandlerIdx + 800);
    expect(wheelHandlerBlock).toContain('stepAlternateScreenScroll');
    expect(wheelHandlerBlock).toContain('mouseTrackingActive');
  });

  it('WebTerminalView maps mobile touch scroll using touch lineHeight-scaled threshold in alternate screen buffer', () => {
    const applyScrollDeltaIdx = webTerminalContent.indexOf('const applyScrollDelta =');
    const applyScrollDeltaBlock = webTerminalContent.slice(applyScrollDeltaIdx, applyScrollDeltaIdx + 1200);
    expect(applyScrollDeltaBlock).toContain("term.buffer?.active?.type === 'alternate'");
    expect(applyScrollDeltaBlock).toContain('stepAlternateScreenScroll');
    expect(applyScrollDeltaBlock).toContain('mouseTrackingActive');
    expect(applyScrollDeltaBlock).toContain('lineThresholdPx:');
    expect(applyScrollDeltaBlock).toContain('maxLineStepsPerEvent:');
  });

  it('WebTerminalView handleTouchMove dispatches alternate screen scroll directly without waiting for rAF flush', () => {
    const touchMoveIdx = webTerminalContent.indexOf('const handleTouchMove =');
    const touchEndIdx = webTerminalContent.indexOf('const handleTouchEnd =', touchMoveIdx);
    const touchMoveBlock = webTerminalContent.slice(touchMoveIdx, touchEndIdx);
    expect(touchMoveBlock).toContain("term.buffer?.active?.type === 'alternate'");
    expect(touchMoveBlock).toContain('applyScrollDelta(frameDeltaY)');
  });

  it('WebTerminalView handleTouchEnd enables damped momentum scroll for mouse-tracked alternate screen and disables it for non-mouse alternate screen', () => {
    const touchEndIdx = webTerminalContent.indexOf('const handleTouchEnd =');
    const touchCancelIdx = webTerminalContent.indexOf('const handleTouchCancel =', touchEndIdx);
    const touchEndBlock = webTerminalContent.slice(touchEndIdx, touchCancelIdx);
    expect(touchEndBlock).toContain('isAltMouseTracking');
    expect(touchEndBlock).toContain('!isAltBuffer || isAltMouseTracking');
    expect(touchEndBlock).toContain('startMomentumScroll');

    const momentumIdx = webTerminalContent.indexOf('const startMomentumScroll =');
    const momentumEndIdx = webTerminalContent.indexOf('const handleMouseUp =', momentumIdx);
    const momentumBlock = webTerminalContent.slice(momentumIdx, momentumEndIdx);
    expect(momentumBlock).toContain('startedInAltScreen !== currentlyAlt');
  });

  it('WebTerminalView onData does not unconditionally force scrollToBottomSafe when user is scrolled up', () => {
    const onDataIdx = webTerminalContent.indexOf('term.onData((data) => {');
    const onDataBlock = webTerminalContent.slice(onDataIdx, onDataIdx + 1200);
    expect(onDataBlock).toContain("data === '\\r' || data === '\\n' || isAtBottomRef.current");
  });

  it('WebTerminalView provides 10000 default scrollback lines for extensive transcripts', () => {
    expect(webTerminalContent).toContain('defaultScrollback = 10000');
  });

  it('WebTerminalView writeScheduler callback skips scrollToBottomSafe when viewportY is already at baseY', () => {
    const schedulerIdx = webTerminalContent.indexOf('writeSchedulerRef.current = new TerminalWriteScheduler');
    const schedulerBlock = webTerminalContent.slice(schedulerIdx, schedulerIdx + 700);
    expect(schedulerBlock).toContain('t.buffer.active.viewportY < t.buffer.active.baseY');
  });

  it('WebTerminalView safeFit skips fitAddon.fit and full-screen term.refresh when dimensions are unchanged and not forced', () => {
    const safeFitStart = webTerminalContent.indexOf('const safeFit = useCallback');
    const safeFitEnd = webTerminalContent.indexOf('const safeFitRef =', safeFitStart);
    const safeFitBlock = webTerminalContent.slice(safeFitStart, safeFitEnd);
    expect(safeFitBlock).toContain('!forceResize && proposed.cols === term.cols && proposed.rows === term.rows');
  });

  it('WebTerminalView tracks real-time alt-screen state via updateRemoteAltScreenState and gates wheel/touch scroll on isRemoteAltScreenRef', () => {
    expect(webTerminalContent).toContain('updateRemoteAltScreenState');
    expect(webTerminalContent).toContain('isRemoteAltScreenRef.current');
    const wheelHandlerIdx = webTerminalContent.indexOf('term.attachCustomWheelEventHandler');
    const wheelHandlerBlock = webTerminalContent.slice(wheelHandlerIdx, wheelHandlerIdx + 1200);
    expect(wheelHandlerBlock).toContain('isRemoteAltScreenRef.current');
    expect(wheelHandlerBlock).toContain('coreMouseService?.reset');
  });

  it('WebTerminalView resets altScrollState and orphaned mouse tracking on buffer change to normal', () => {
    expect(webTerminalContent).toContain('term.buffer.onBufferChange');
    expect(webTerminalContent).toContain('bufferChangeDisposable.dispose()');
  });
});
