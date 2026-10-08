import * as fs from 'fs';
import * as path from 'path';

describe('Terminal Mobile Keyboard History Scroll Lock Tests', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');

  const unifiedContent = fs.readFileSync(unifiedPath, 'utf-8');
  const webTerminalContent = fs.readFileSync(webTerminalPath, 'utf-8');

  it('verifies UnifiedTerminalView does not call terminal.fit() on keyboard popup', () => {
    // Should set workspaceStyle and call scrollToBottomSafe, but NOT call fit() which shrinks rows
    const handlerStart = unifiedContent.indexOf('if (offsetResult.isKeyboardShowing)');
    const handlerEnd = unifiedContent.indexOf('} else {', handlerStart);
    const ifBlock = unifiedContent.slice(handlerStart, handlerEnd);
    expect(ifBlock).not.toContain('terminalRef.current?.fit()');
    expect(ifBlock).toContain('terminalRef.current?.scrollToBottomSafe?.()');
  });

  it('verifies safeFit in WebTerminalView suppresses row resizing while mobile keyboard is showing', () => {
    expect(webTerminalContent).toContain('!forceResize && isMobile && standalone && isKeyboardShowingRef.current');
  });

  it('verifies WebTerminalView skips safeFit when keyboard closes with stable width', () => {
    expect(webTerminalContent).toContain('const isWidthStable = Math.abs(window.innerWidth - baseWidthRef.current) <= 20;');
    expect(webTerminalContent).toContain('if (!mobile || !standalone || !isWidthStable)');
  });

  it('verifies WebTerminalView anchors to bottom cursor when keyboard opens', () => {
    expect(webTerminalContent).toContain('if (blockResize)');
    expect(webTerminalContent).toContain('scrollToBottomSafe(xtermRef.current);');
  });

  it('verifies CSS height transition is disabled (transition: none) in both views', () => {
    expect(unifiedContent).toContain("transition: 'none'");
    expect(webTerminalContent).toContain("transition: 'none'");
    expect(unifiedContent).not.toContain("transition: 'height 0.22s");
    expect(webTerminalContent).not.toContain("transition: 'height 0.22s");
  });

  it('verifies ResizeObserver uses requestAnimationFrame and respects isKeyboardShowingRef', () => {
    expect(webTerminalContent).toContain('let resizeRaf: number | null = null;');
    expect(webTerminalContent).toContain('if (isKeyboardShowingRef.current)');
    expect(webTerminalContent).toContain('safeFitRef.current?.(false);');
  });

  it('verifies textarea.focus uses { preventScroll: true }', () => {
    expect(webTerminalContent).toContain('textarea.focus({ preventScroll: true });');
  });

  it('verifies WebTerminalHandle exposes isAtBottom and UnifiedTerminalView uses it', () => {
    expect(webTerminalContent).toContain('isAtBottom?: () => boolean;');
    expect(webTerminalContent).toContain('isAtBottom: () => {');
    expect(unifiedContent).toContain('terminalRef.current?.isAtBottom');
  });

  it('verifies baseHeightRef is guarded against Android Chrome keyboard pollution', () => {
    expect(webTerminalContent).toContain('isNearFullHeight');
    expect(webTerminalContent).toContain('!isInputFocused && isNearFullHeight');
  });

  it('verifies UnifiedTerminalView window resize listener guards mobile devices entirely', () => {
    expect(unifiedContent).toContain("if (subTab === 'interactive' && !isMobile)");
  });

  it('verifies UnifiedTerminalView anchors to bottom only on transition and guards baseHeightRef with isNearFullHeight', () => {
    expect(unifiedContent).toContain('const wasKeyboardShowing = isKeyboardShowingRef.current;');
    expect(unifiedContent).toContain('if (!wasKeyboardShowing)');
    expect(unifiedContent).toContain('isNearFullHeight');
  });

  it('verifies WebTerminalView handleHideKeyboard skips safeFit(true) on mobile standalone with stable width', () => {
    const hideFnStart = webTerminalContent.indexOf('const handleHideKeyboard = () => {');
    const hideFnEnd = webTerminalContent.indexOf('const fontSizeRef =', hideFnStart);
    const hideFnBlock = webTerminalContent.slice(hideFnStart, hideFnEnd);
    expect(hideFnBlock).toContain('if (!isMobile || !standalone || !isWidthStable)');
  });

  it('verifies WebTerminalView blockResize anchors to bottom only on initial keyboard opening transition', () => {
    expect(webTerminalContent).toContain('if (!wasKeyboardShowing && xtermRef.current)');
  });

  it('verifies WebTerminalView safeFit and ResizeObserver check isKeyboardActive directly to prevent race conditions', () => {
    expect(webTerminalContent).toContain('isKeyboardActive');
    expect(webTerminalContent).toContain('if (isWidthStable && (isKeyboardActive || isKeyboardShowingRef.current))');
  });

  it('verifies sendResize directly intercepts and blocks mobile keyboard row reduction leaks', () => {
    expect(webTerminalContent).toContain('Blocked mobile keyboard resize leak');
    expect(webTerminalContent).toContain('isHeightShrunk || isKeyboardActive');
  });

  it('verifies updateViewport does not resize rows on mobile unless width changes', () => {
    expect(webTerminalContent).toContain('const isWidthChanged = Math.abs(window.innerWidth - baseWidthRef.current) > 20;');
    expect(webTerminalContent).toContain('if ((!mobile || isWidthChanged) && !wasKeyboardShowing && fitAddonRef.current && xtermRef.current)');
  });
});
