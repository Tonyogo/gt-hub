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

  it('verifies terminalContainerRef applies translateY transform with transition none', () => {
    expect(webTerminalContent).toContain("transform: cursorShiftY > 0 ? `translateY(-${cursorShiftY}px)` : undefined");
    expect(webTerminalContent).toContain("transition: 'none'");
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
});
