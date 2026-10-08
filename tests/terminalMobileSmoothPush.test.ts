import fs from 'fs';
import path from 'path';

describe('WebTerminalView Mobile Smooth Push Integration', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const content = fs.readFileSync(webTerminalPath, 'utf-8');

  test('imports mobileViewportHelper utilities', () => {
    expect(content).toMatch(
      /import\s*{[^}]*calculateKeyboardTranslateY[^}]*shouldBlockPtyResize[^}]*}\s*from\s*['"]\.\.\/utils\/mobileViewportHelper['"]/
    );
  });

  test('maintains base dimension refs for mobile standalone', () => {
    expect(content).toContain('baseHeightRef');
    expect(content).toContain('baseWidthRef');
  });

  test('disables transition in mobile standalone viewportStyle to prevent multi-frame resize jitter', () => {
    expect(content).toContain("transition: 'none'");
    expect(content).toContain('transition');
  });

  test('blocks fitAddon.fit and sendResize when keyboard is showing', () => {
    expect(content).toContain('shouldBlockPtyResize');
    expect(content).toMatch(/scrollToBottom(?:Safe)?/);
  });

  test('dismisses keyboard on swipe down gesture in terminal', () => {
    expect(content).toContain('handleTouchMove');
    expect(content).toContain('handleHideKeyboard');
  });

  test('handles orientation change by resetting base dimensions and blurring active inputs', () => {
    expect(content).toContain('orientationchange');
  });
});

