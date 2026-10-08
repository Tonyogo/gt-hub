import fs from 'fs';
import path from 'path';

describe('WebTerminal Anti-Flicker & Empty State Tests', () => {
  const terminalViewPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const selectorPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalHostSelector.tsx');
  const terminalContent = fs.readFileSync(terminalViewPath, 'utf-8');
  const selectorContent = fs.readFileSync(selectorPath, 'utf-8');

  test('does not render full-screen terminal-empty-state overlay in WebTerminalView to prevent network jitter flickering', () => {
    expect(terminalContent).not.toContain('terminal-empty-state');
  });

  test('unifies node addition into TerminalHostSelector with quick plus button and icon-only copy button', () => {
    expect(selectorContent).toContain('webTerminal.hostSelector.addNode');
    expect(selectorContent).toContain('<Plus');
    // Ensure copy button does not contain span text labels
    expect(selectorContent).not.toContain('<span>{copied ?');
  });

  test('ensures useMemo is imported in WebTerminalView to prevent runtime ReferenceError', () => {
    const importReactLine = terminalContent.split('\n').find((l) => l.startsWith('import React'));
    expect(importReactLine).toBeDefined();
    expect(importReactLine).toContain('useMemo');
  });
});
