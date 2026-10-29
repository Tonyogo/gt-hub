import * as fs from 'fs';
import * as path from 'path';

describe('WebTerminalView & useTerminalWebSocket Split-Pane Support', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const hookPath = path.resolve(__dirname, '../frontend/src/components/terminal/hooks/useTerminalWebSocket.ts');
  const zhPath = path.resolve(__dirname, '../frontend/src/i18n/locales/zh.ts');
  const enPath = path.resolve(__dirname, '../frontend/src/i18n/locales/en.ts');

  it('WebTerminalViewProps and WebTerminalHandle declare paneId, focus, and closePaneSession interfaces', () => {
    const content = fs.readFileSync(webTerminalPath, 'utf-8');
    expect(content).toContain("paneId?: 'main' | 'split'");
    expect(content).toContain('isFocusedPane?: boolean');
    expect(content).toContain('onFocusPane?: () => void');
    expect(content).toContain('onPaneExit?: () => void');
    expect(content).toContain('closePaneSession: () => void');
    expect(content).toContain('focus: () => void');
  });

  it('appends paneId query parameter to WebSocket URL and handles pane_exit / pane_close', () => {
    const webTerminalContent = fs.readFileSync(webTerminalPath, 'utf-8');
    const hookContent = fs.readFileSync(hookPath, 'utf-8');
    expect(webTerminalContent).toContain('paneId=');
    expect(webTerminalContent).toContain("parsed.type === 'pane_exit'");
    expect(webTerminalContent).toContain("type: 'pane_close'");
    expect(hookContent).toContain('paneId');
  });

  it('defines split pane translation keys in both zh and en locales', () => {
    const zh = fs.readFileSync(zhPath, 'utf-8');
    const en = fs.readFileSync(enPath, 'utf-8');
    expect(zh).toContain('splitPane:');
    expect(zh).toContain('closeSplitPane:');
    expect(en).toContain('splitPane:');
    expect(en).toContain('closeSplitPane:');
  });
});
