import * as fs from 'fs';
import * as path from 'path';

describe('Terminal Fullscreen Connection Reuse & Lifecycle', () => {
  const terminalViewPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const appPath = path.resolve(__dirname, '../frontend/src/App.tsx');

  let terminalContent: string;
  let appContent: string;

  beforeAll(() => {
    terminalContent = fs.readFileSync(terminalViewPath, 'utf-8');
    appContent = fs.readFileSync(appPath, 'utf-8');
  });

  test('WebTerminalView main init effect should NOT depend on standalone', () => {
    // The main useEffect that creates Terminal and WebSocket must not have standalone in dependency array
    expect(terminalContent).not.toMatch(/term\.dispose\(\);\s*\}\s*;\s*\}\s*,\s*\[[^\]]*\bstandalone\b/);
  });

  test('WebTerminalView should have dedicated standalone effect for fit and sendResize', () => {
    expect(terminalContent).toMatch(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?fitAddonRef\.current[\s\S]*?sendResize[\s\S]*?\}\s*,\s*\[\s*standalone/);
  });

  test('App.tsx should NOT unmount terminal on standalone toggle via early return', () => {
    // Should eliminate early return `if (isStandaloneTerminal) return ...`
    expect(appContent).not.toMatch(/if\s*\(\s*isStandaloneTerminal\s*\)\s*\{\s*return\s*\(\s*<div[^>]*>\s*<WebTerminalView/);
  });

  test('WebTerminalView does not invoke HTML5 requestFullscreen to prevent Esc key conflicts in CLI apps', () => {
    expect(terminalContent).not.toContain('document.documentElement.requestFullscreen');
    expect(terminalContent).not.toContain('document.exitFullscreen');
  });

  test('App.tsx does not render duplicate mobile terminal fullscreen button, relying on UnifiedTerminalView', () => {
    expect(appContent).not.toContain('Mobile Terminal Fullscreen Trigger');
    expect(appContent).not.toMatch(/onClick=\{handleEnterStandalone\}[^>]*md:hidden/);

    const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
    const unifiedContent = fs.readFileSync(unifiedPath, 'utf-8');
    expect(unifiedContent).toContain('handleFullscreenToggle');
    expect(unifiedContent).toMatch(/isStandalone\s*\?\s*<Minimize2[^>]*\/>\s*:\s*<Maximize2[^>]*\/>/);
  });
});
