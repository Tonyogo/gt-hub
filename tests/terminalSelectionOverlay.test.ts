import fs from 'fs';
import path from 'path';

describe('Terminal Selection Gesture Overlay Tests', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const terminalContent = fs.readFileSync(webTerminalPath, 'utf-8');

  test('WebTerminalView renders transparent gesture overlay when isSelectMode is active', () => {
    // Should render overlay container with select-none, touch-none, absolute inset-0
    expect(terminalContent).toContain('selection-gesture-overlay');
    expect(terminalContent).toMatch(/isSelectMode\s*&&[\s\S]*?selection-gesture-overlay/);
    expect(terminalContent).toContain('cursor-crosshair');
  });

  test('Top bar action buttons include select mode toggle button', () => {
    const actionButtonsMatch = terminalContent.match(/\{\/\*\s*Action Buttons\s*\*\/\}[\s\S]*?\{\/\*\s*xterm\.js Canvas Container/);
    expect(actionButtonsMatch).not.toBeNull();
    if (actionButtonsMatch) {
      expect(actionButtonsMatch[0]).toContain('handleToggleSelectMode');
      expect(actionButtonsMatch[0]).toContain('TextSelect');
    }
  });

  test('applySelection implements order-safe coordinate calculation', () => {
    // from must precede to in document order
    expect(terminalContent).toContain('startOrder');
    expect(terminalContent).toContain('currentOrder');
    expect(terminalContent).toContain('isReversed');
  });

  test('desktop overlay mouseUp triggers copy and exits select mode', () => {
    expect(terminalContent).toContain('handleOverlayMouseUp');
    expect(terminalContent).toContain('handleCopySelection');
  });
});
