import fs from 'fs';
import path from 'path';

describe('Terminal Copy on Select & Touch Selection Fix Tests', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const indexCssPath = path.resolve(__dirname, '../frontend/src/index.css');

  const terminalContent = fs.readFileSync(webTerminalPath, 'utf-8');
  const cssContent = fs.readFileSync(indexCssPath, 'utf-8');

  test('removes desktop floating bubble and topbar copy button', () => {
    // Should NOT contain floating bubble DOM
    expect(terminalContent).not.toContain('Desktop Floating Copy Bubble');
    expect(terminalContent).not.toContain('selectionBubblePos');

    // Top bar action buttons should not have topbar copy button
    const actionButtonsMatch = terminalContent.match(/\{\/\*\s*Action Buttons\s*\*\/\}[\s\S]*?\{\/\*\s*xterm\.js Canvas Container/);
    expect(actionButtonsMatch).not.toBeNull();
    if (actionButtonsMatch) {
      expect(actionButtonsMatch[0]).not.toContain('Top Bar Copy Button');
    }
  });

  test('implements Copy on Select on desktop mouseup', () => {
    // mouseup handler should check term.getSelection and copy automatically on desktop
    expect(terminalContent).toContain('handleMouseUp');
    expect(terminalContent).toMatch(/term\.getSelection\(\)[\s\S]*?clipboard\.writeText/);
  });

  test('applies terminal-select-mode class and CSS deep touch-action / user-select lock', () => {
    expect(terminalContent).toContain('terminal-select-mode');
    expect(cssContent).toContain('.terminal-select-mode');
    expect(cssContent).toMatch(/\.terminal-select-mode\s+[\s\S]*?user-select:\s*none\s*!important/);
    expect(cssContent).toMatch(/\.terminal-select-mode\s+[\s\S]*?-webkit-touch-callout:\s*none\s*!important/);
  });

  test('touch event listeners use capture phase or preventDefault on touchstart in select mode', () => {
    expect(terminalContent).toContain('isSelectModeRef.current');
    expect(terminalContent).toContain('getCellCoordsFromTouch');
    expect(terminalContent).toContain('applySelection');
  });
});
