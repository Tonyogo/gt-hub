import * as fs from 'fs';
import * as path from 'path';

describe('Terminal Mobile Virtual Keyboard Push-Up & Cursor Anchoring Tests', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');

  const unifiedContent = fs.readFileSync(unifiedPath, 'utf-8');
  const webTerminalContent = fs.readFileSync(webTerminalPath, 'utf-8');

  it('verifies WebTerminalHandle exposes updateCursorShift and WebTerminalView implements it', () => {
    expect(webTerminalContent).toContain('updateCursorShift?: () => void;');
    expect(webTerminalContent).toContain('updateCursorShift: () => {');
  });

  it('verifies cursorShiftY state and updateCursorShift calculation exist in WebTerminalView', () => {
    expect(webTerminalContent).toContain('const [cursorShiftY, setCursorShiftY] = useState<number>(0);');
    expect(webTerminalContent).toContain('const cursorShiftYRef = useRef<number>(0);');
    expect(webTerminalContent).toContain('const updateCursorShift = useCallback(');
  });

  it('verifies updateCursorShift computes shift based on active cursor row and container height', () => {
    expect(webTerminalContent).toContain('term.buffer?.active?.cursorY');
    expect(webTerminalContent).toContain('const targetShift = Math.max(0, cursorBottom - visibleHeight + 4);');
    expect(webTerminalContent).toContain('const shift = Math.min(maxShift, targetShift);');
  });

  it('verifies terminalContainerRef applies translateY transform with mobile smooth cubic-bezier transition', () => {
    expect(webTerminalContent).toContain("transform: cursorShiftY > 0 ? `translateY(-${cursorShiftY}px)` : undefined");
    expect(webTerminalContent).toContain("transition: isMobile ? 'transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)' : 'none'");
  });

  it('verifies UnifiedTerminalView unconditionally anchors to bottom and triggers updateCursorShift on keyboard open', () => {
    const handlerStart = unifiedContent.indexOf('if (offsetResult.isKeyboardShowing)');
    const handlerEnd = unifiedContent.indexOf('} else {', handlerStart);
    const ifBlock = unifiedContent.slice(handlerStart, handlerEnd);

    expect(ifBlock).toContain('terminalRef.current?.scrollToBottomSafe?.()');
    expect(ifBlock).toContain('terminalRef.current?.updateCursorShift?.()');
  });

  it('verifies UnifiedTerminalView triggers updateCursorShift when keyboard closes', () => {
    const handlerStart = unifiedContent.indexOf('if (offsetResult.isKeyboardShowing)');
    const elseStart = unifiedContent.indexOf('} else {', handlerStart);
    const elseEnd = unifiedContent.indexOf('};', elseStart);
    const elseBlock = unifiedContent.slice(elseStart, elseEnd);

    expect(elseBlock).toContain('setWorkspaceStyle({});');
    expect(elseBlock).toContain('terminalRef.current?.updateCursorShift?.()');
  });

  it('verifies xterm cursorMove and render events re-evaluate updateCursorShift for live typing', () => {
    expect(webTerminalContent).toContain('term.onCursorMove(');
    expect(webTerminalContent).toContain('term.onRender(');
    expect(webTerminalContent).toContain('cursorMoveDisposable.dispose();');
    expect(webTerminalContent).toContain('renderDisposable.dispose();');
  });

  it('verifies ResizeObserver triggers updateCursorShift during keyboard transitions', () => {
    const observerStart = webTerminalContent.indexOf('const resizeObserver = new ResizeObserver');
    const observerEnd = webTerminalContent.indexOf('if (terminalContainerRef.current) {', observerStart);
    const observerBlock = webTerminalContent.slice(observerStart, observerEnd);

    expect(observerBlock).toContain('if (isKeyboardShowingRef.current)');
    expect(observerBlock).toContain('updateCursorShiftRef.current?.();');
  });

  it('verifies handleHideKeyboard resets cursorShiftY immediately upon dismissal', () => {
    const hideFnStart = webTerminalContent.indexOf('const handleHideKeyboard = () => {');
    const hideFnEnd = webTerminalContent.indexOf('const fontSizeRef =', hideFnStart);
    const hideFnBlock = webTerminalContent.slice(hideFnStart, hideFnEnd);

    expect(hideFnBlock).toContain('cursorShiftYRef.current = 0;');
    expect(hideFnBlock).toContain('setCursorShiftY(0);');
  });

  it('verifies updateCursorShift calculates visible terminal height directly from visual viewport geometry', () => {
    expect(webTerminalContent).toContain('vv.height - headerHeight - accessoryBarHeight - padding');
    expect(webTerminalContent).toContain('accessoryBarRef');
  });

  it('verifies term.onLineFeed listener with RAF is attached and disposed for remote output follow-through', () => {
    expect(webTerminalContent).toContain('term.onLineFeed(');
    expect(webTerminalContent).toContain('lineFeedDisposable.dispose();');
    expect(webTerminalContent).toContain('scheduleCursorShift');
  });

  it('verifies smooth transition styling is applied to terminalContainerRef on mobile', () => {
    expect(webTerminalContent).toContain("transition: isMobile ? 'transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)' : 'none'");
  });

  it('verifies accessoryBarRef has terminal-accessory-bar class for DOM queries', () => {
    expect(webTerminalContent).toContain('className="terminal-accessory-bar shrink-0"');
  });

  it('verifies scheduleCursorShift checks requestAnimationFrame availability safely', () => {
    expect(webTerminalContent).toContain("typeof requestAnimationFrame !== 'undefined'");
    expect(webTerminalContent).toContain("typeof cancelAnimationFrame !== 'undefined'");
  });

  describe('Chat-like Push-Up Mathematical Model Simulation', () => {
    function simulateCursorShift({
      vvHeight,
      headerHeight = 44,
      accessoryBarHeight = 44,
      padding = 16,
      rows = 30,
      cellHeight = 15,
      cursorY,
    }: {
      vvHeight: number;
      headerHeight?: number;
      accessoryBarHeight?: number;
      padding?: number;
      rows?: number;
      cellHeight?: number;
      cursorY: number;
    }) {
      const visibleHeight = Math.max(100, Math.round(vvHeight - headerHeight - accessoryBarHeight - padding));
      const totalScreenHeight = rows * cellHeight;
      const cursorBottom = (cursorY + 1) * cellHeight;
      const maxShift = Math.max(0, Math.max(totalScreenHeight, rows * cellHeight) - visibleHeight);
      const targetShift = Math.max(0, cursorBottom - visibleHeight + 4);
      const shift = Math.min(maxShift, targetShift);
      return { visibleHeight, shift, cursorVisibleY: cursorBottom - shift };
    }

    it('does not shift terminal up when cursor is well within visible viewport (cursor near top)', () => {
      // Screen height: 800, keyboard takes 400 => vv.height = 400
      // visibleHeight = 400 - 44 - 44 - 16 = 296
      // Cursor is at row 5 (cursorBottom = 6 * 15 = 90)
      const res = simulateCursorShift({ vvHeight: 400, cursorY: 5 });
      expect(res.visibleHeight).toBe(296);
      expect(res.shift).toBe(0);
      expect(res.cursorVisibleY).toBe(90);
    });

    it('anchors cursor line to bottom of visible area like a chat app when keyboard is active', () => {
      // Cursor is at row 25 (cursorBottom = 26 * 15 = 390)
      // visibleHeight = 296
      // targetShift = 390 - 296 + 4 = 98
      const res = simulateCursorShift({ vvHeight: 400, cursorY: 25 });
      expect(res.shift).toBe(98);
      // Cursor visible bottom should sit exactly at visibleHeight - 4 (292px)
      expect(res.cursorVisibleY).toBe(res.visibleHeight - 4);
    });

    it('clamps shift to maxShift when cursor is at the very bottom line of buffer', () => {
      // Cursor is at row 29 (cursorBottom = 30 * 15 = 450)
      // totalScreenHeight = 450, visibleHeight = 296
      // maxShift = 450 - 296 = 154
      // targetShift = 450 - 296 + 4 = 158 => clamped to 154
      const res = simulateCursorShift({ vvHeight: 400, cursorY: 29 });
      expect(res.shift).toBe(154);
    });
  });
});
