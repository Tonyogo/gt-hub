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

  test('drives .xterm-viewport scrollTop directly with RAF coalescing and sub-line translate3d', () => {
    expect(content).toContain('applyViewportTouchScrollDelta');
    expect(content).toContain('.xterm-viewport');
    expect(content).toContain('pendingTouchDeltaY');
    expect(content).toContain('translate3d(0,');
  });

  test('defers setIsAtBottom React re-renders while touch scrolling or momentum is active', () => {
    expect(content).toContain('isTouchScrollingActiveRef');
  });
});

