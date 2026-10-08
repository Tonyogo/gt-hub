import fs from 'fs';
import path from 'path';

describe('Terminal Mobile Selection and Copy/Paste Integration', () => {
  const accessoryBarPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalAccessoryBar.tsx');
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const zhLocalePath = path.resolve(__dirname, '../frontend/src/i18n/locales/zh.ts');
  const enLocalePath = path.resolve(__dirname, '../frontend/src/i18n/locales/en.ts');

  it('verifies TerminalAccessoryBar provides paste, copy, and select mode buttons in right fixed controls', () => {
    const content = fs.readFileSync(accessoryBarPath, 'utf8');
    expect(content).toContain('onPaste');
    expect(content).toContain('onCopy');
    expect(content).toContain('onToggleSelectMode');
    expect(content).toContain('ClipboardPaste');
    expect(content).toContain('TextSelect');
    expect(content).toContain('hasSelection');
    expect(content).toContain('isSelectMode');

    // Button should be in right fixed controls (shrink-0) and use smart onClick
    expect(content).toContain('onClick={hasSelection ? onCopy : onToggleSelectMode}');
    expect(content).toContain('Right Fixed Controls: Selection/Copy');
    expect(content).not.toContain('onOpenSnippets');
    expect(content).not.toContain('Sparkles');
  });

  it('verifies WebTerminalView implements selection, clipboard copy, and auto-reset', () => {
    const content = fs.readFileSync(webTerminalPath, 'utf8');
    expect(content).toContain('handleCopySelection');
    expect(content).toContain('handlePasteClipboard');
    expect(content).toContain('handleToggleSelectMode');
    expect(content).toContain('handleSelectAll');
    expect(content).toContain('handleClearSelection');
    expect(content).toContain('onSelectionChange');
    expect(content).toContain('getCellCoordsFromTouch');
    expect(content).toContain('term.select(');

    // Touch selection engine and buffer row mapping
    expect(content).toContain('bufferRow');
    expect(content).toContain('viewportY + viewportRow');
    expect(content).toContain('applySelection');
    expect(content).toContain('touchAction');

    // Auto-exit selection mode and clear selection upon copying
    expect(content).toContain('setIsSelectMode(false)');
    expect(content).toContain('isSelectModeRef.current = false');
    expect(content).toContain('xtermRef.current?.clearSelection()');
    expect(content).toContain('setHasSelection(false)');

    // Floating selection toolbar components
    expect(content).toContain('webTerminal.selectAllVisible');
    expect(content).toContain('webTerminal.clearSelection');
    expect(content).toContain('webTerminal.copy');
    expect(content).toContain('webTerminal.done');
  });

  it('verifies localization strings are present in both zh.ts and en.ts', () => {
    const zh = fs.readFileSync(zhLocalePath, 'utf8');
    const en = fs.readFileSync(enLocalePath, 'utf8');

    const keys = [
      'copy',
      'paste',
      'copySelection',
      'copiedToast',
      'copiedToClipboard',
      'selectMode',
      'selectModeActive',
      'selectModeTip',
      'selectAll',
      'selectAllVisible',
      'clearSelection',
      'exitSelectMode'
    ];

    for (const key of keys) {
      expect(zh).toContain(`${key}:`);
      expect(en).toContain(`${key}:`);
    }
  });
});
