import * as fs from 'fs';
import * as path from 'path';

describe('Terminal Mobile Fullscreen Header Optimization Tests', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  const selectorPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalHostSelector.tsx');
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');

  const unifiedContent = fs.readFileSync(unifiedPath, 'utf-8');
  const selectorContent = fs.readFileSync(selectorPath, 'utf-8');
  const webTerminalContent = fs.readFileSync(webTerminalPath, 'utf-8');

  it('verifies TerminalHostSelector supports connectionStatus prop and integrates status dot', () => {
    expect(selectorContent).toContain('connectionStatus?:');
    expect(selectorContent).toContain('connectionStatus.isConnected');
    expect(selectorContent).toContain('connectionStatus.isConnecting');
  });

  it('verifies TerminalHostSelector hides quick-add plus button on mobile and narrows name width', () => {
    expect(selectorContent).toContain('hidden sm:inline-flex p-1 sm:p-1.5 rounded-lg bg-white/[0.04]');
    expect(selectorContent).toContain('max-w-[72px] sm:max-w-[130px]');
  });

  it('verifies UnifiedTerminalView passes connectionStatus to TerminalHostSelector and hides redundant mobile badge', () => {
    expect(unifiedContent).toContain('connectionStatus={connectionStatus}');
    expect(unifiedContent).toContain('hidden sm:flex items-center space-x-1');
  });

  it('verifies UnifiedTerminalView renders Minimize2 button only on desktop when in standalone mode', () => {
    expect(unifiedContent).toContain('!isMobile');
    expect(unifiedContent).toContain('Minimize2');
  });

  it('verifies WebTerminalView hides redundant mobile badge and Minimize2 button when in standalone mode', () => {
    expect(webTerminalContent).toContain('hidden sm:flex items-center space-x-1 sm:space-x-1.5');
    expect(webTerminalContent).toContain("standalone\n                ? 'hidden sm:inline-flex bg-indigo-500/20 text-indigo-300 border-indigo-500/30'");
  });
});
