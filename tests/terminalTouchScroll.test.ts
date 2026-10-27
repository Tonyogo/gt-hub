import fs from 'fs';
import path from 'path';

describe('Terminal Mobile Touch Scroll Parity Tests', () => {
  const terminalViewPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const content = fs.readFileSync(terminalViewPath, 'utf-8');

  test('mobile touch swipe always scrolls line buffer directly without translating into arrow keys', () => {
    // Should call term.scrollLines on swipe
    expect(content).toContain('term.scrollLines(linesToScroll)');
    // Should NOT translate vertical touch swipe into arrow sequences (\x1b[A / \x1b[B)
    const touchMoveSection = content.slice(content.indexOf('const handleTouchMove'), content.indexOf('const handleTouchEnd'));
    expect(touchMoveSection).not.toContain("linesToScroll > 0 ? '\\x1b[B' : '\\x1b[A'");
    expect(touchMoveSection).not.toContain('arrowSequence');
  });

  test('implements kinetic momentum scrolling and cancels on touchstart', () => {
    expect(content).toContain('computeTouchVelocity');
    expect(content).toContain('stepMomentumVelocity');
    expect(content).toContain('stepTouchScrollLines');
    expect(content).toContain('stopMomentumScroll');
  });

  test('prevents browser pan-y gesture hijacking on mobile terminal canvas', () => {
    expect(content).toContain("touchAction: isSelectMode || isMobile ? 'none' : 'pan-y'");
  });

  test('drives .xterm-viewport scrollTop directly with RAF coalescing and without .xterm-screen translate3d flicker', () => {
    expect(content).toContain('applyViewportTouchScrollDelta');
    expect(content).toContain('.xterm-viewport');
    expect(content).toContain('pendingTouchDeltaY');
    expect(content).not.toContain('setSubLineTransform');
    expect(content).not.toContain('translate3d(0,');
  });

  test('defers setIsAtBottom React re-renders while touch scrolling or momentum is active', () => {
    expect(content).toContain('isTouchScrollingActiveRef');
  });

  test('preserves initial pre-drag displacement and locks touch-action on .xterm-viewport', () => {
    const touchMoveSection = content.slice(content.indexOf('const handleTouchMove'), content.indexOf('const handleTouchEnd'));
    const notDraggingGuardIdx = touchMoveSection.indexOf('if (!isDragging) return;');
    const lastTouchUpdateIdx = touchMoveSection.indexOf('lastTouchY = currentY;');

    expect(notDraggingGuardIdx).toBeGreaterThan(-1);
    expect(lastTouchUpdateIdx).toBeGreaterThan(notDraggingGuardIdx);
    expect(content).toContain("xtermViewport.style.touchAction = defaultTouchAction");
  });

  test('applyScrollDelta always calls term.scrollLines(linesToScroll) so xterm ydisp never desyncs or snaps back', () => {
    const applyStart = content.indexOf('const applyScrollDelta =');
    const applyEnd = content.indexOf('const flushPendingTouchScroll =', applyStart);
    const applyBlock = content.slice(applyStart, applyEnd);

    const scrollLinesIdx = applyBlock.indexOf('term.scrollLines(linesToScroll)');
    const usedNativeIdx = applyBlock.indexOf('if (res.usedNativeScrollTop)');
    expect(scrollLinesIdx).toBeGreaterThan(-1);
    // term.scrollLines must NOT be bypassed by an early return on res.usedNativeScrollTop
    expect(usedNativeIdx === -1 || scrollLinesIdx < usedNativeIdx).toBe(true);
  });

  test('handleTouchStart calls e.stopPropagation on touches to isolate from xterm internal listeners', () => {
    const touchStartIdx = content.indexOf('const handleTouchStart =');
    const touchEndIdx = content.indexOf('const handleTouchMove =', touchStartIdx);
    const touchStartBlock = content.slice(touchStartIdx, touchEndIdx);

    const selectModeIdx = touchStartBlock.indexOf('if (isSelectModeRef.current)');
    const firstStopPropIdx = touchStartBlock.indexOf('e.stopPropagation()');
    expect(firstStopPropIdx).toBeGreaterThan(-1);
    expect(firstStopPropIdx).toBeLessThan(selectModeIdx);
  });

  test('index.css locks touch-action and disables momentum overflow-scrolling on .xterm-viewport', () => {
    const cssPath = path.resolve(__dirname, '../frontend/src/index.css');
    const cssContent = fs.readFileSync(cssPath, 'utf-8');
    expect(cssContent).toMatch(/\.xterm\s+\.xterm-viewport\s*\{[\s\S]*?touch-action:\s*none\s*!important/);
    expect(cssContent).toMatch(/\.xterm\s+\.xterm-viewport\s*\{[\s\S]*?overscroll-behavior:\s*none\s*!important/);
  });
});

