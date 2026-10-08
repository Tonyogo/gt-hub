import * as fs from 'fs';
import * as path from 'path';

describe('Terminal Mobile Paste Logic Tests', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(webTerminalPath, 'utf-8');
  });

  it('handlePasteClipboard implementation includes async clipboard reading and window.prompt fallback', () => {
    expect(content).toContain('handlePasteClipboard = useCallback(async () => {');
    expect(content).toContain('navigator.clipboard.readText()');
    expect(content).toContain('window.prompt');
    expect(content).toContain("t('webTerminal.pastePromptTip'");
  });

  it('handlePasteClipboard directly sends text via handleSendInput and focuses xterm', () => {
    expect(content).toContain('handleSendInput(clipText, false)');
    expect(content).toContain('xtermRef.current.focus()');
  });

  it('does not send input when user cancels prompt or clipboard is empty', () => {
    // Verifies guard clause if (!clipText) return
    expect(content).toMatch(/if\s*\(!clipText\)\s*\{\s*return;\s*\}/);
  });
});
