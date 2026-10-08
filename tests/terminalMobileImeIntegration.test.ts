import fs from 'fs';
import path from 'path';

describe('WebTerminalView Mobile IME Integration', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');

  test('WebTerminalView imports and connects attachMobileImeHandler', () => {
    const content = fs.readFileSync(webTerminalPath, 'utf-8');

    // Must import attachMobileImeHandler
    expect(content).toMatch(/import\s*{[^}]*attachMobileImeHandler[^}]*}\s*from\s*'\.\.\/utils\/terminalImeHelper'/);

    // Must attach IME handler on helperTextarea
    expect(content).toContain('attachMobileImeHandler');
    expect(content).toContain('onDirectInput:');
    expect(content).toContain('term.input(');

    // Must call controller.dispose() on cleanup
    expect(content).toContain('imeController?.dispose()');
  });
});
