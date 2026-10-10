import * as fs from 'fs';
import * as path from 'path';

describe('Terminal Fullscreen Resize Repaint Stabilization', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');

  let unifiedContent: string;
  let webTerminalContent: string;

  beforeAll(() => {
    unifiedContent = fs.readFileSync(unifiedPath, 'utf-8');
    webTerminalContent = fs.readFileSync(webTerminalPath, 'utf-8');
  });

  it('containers should not have transition-all on geometric properties to prevent resize storms', () => {
    // The root return container in UnifiedTerminalView should not use transition-all
    const unifiedRootContainerMatch = unifiedContent.match(/return\s*\(\s*<div[\s\S]*?className=\{`([\s\S]*?)`\}/);
    expect(unifiedRootContainerMatch).toBeTruthy();
    const unifiedRootClassName = unifiedRootContainerMatch![1];
    expect(unifiedRootClassName).not.toMatch(/\btransition-all\b/);
    expect(unifiedRootClassName).toContain('transition-none');

    // The root return container in WebTerminalView should not use transition-all
    const webTerminalRootContainerMatch = webTerminalContent.match(/return\s*\(\s*<div[\s\S]*?className=\{`([\s\S]*?)`\}/);
    expect(webTerminalRootContainerMatch).toBeTruthy();
    const webTerminalRootClassName = webTerminalRootContainerMatch![1];
    expect(webTerminalRootClassName).not.toMatch(/\btransition-all\b/);
    expect(webTerminalRootClassName).toContain('transition-none');
  });

  it('WebTerminalView should manage isRefitting state to lock scrolling during resize refit', () => {
    expect(webTerminalContent).toContain('isRefitting');
    expect(webTerminalContent).toContain('isRefittingRef');
    // term.write callback must check isRefittingRef before scrolling
    expect(webTerminalContent).toMatch(/!isRefittingRef\.current/);
  });

  it('WebTerminalView should apply subtle visual opacity transition during refit', () => {
    expect(webTerminalContent).toMatch(/isRefitting\s*\?\s*['"]opacity-40/);
  });

  it('WebTerminalView sends client ping heartbeat every 15s and ignores pong responses', () => {
    expect(webTerminalContent).toContain('pingIntervalRef');
    expect(webTerminalContent).toMatch(/pingIntervalRef\.current\s*=\s*setInterval\(\(\)\s*=>\s*\{[\s\S]*?\{ type: 'ping' \}/);
    expect(webTerminalContent).toContain("if (parsed.type === 'pong')");
    expect(webTerminalContent).toContain('clearPingInterval()');
  });

  it('WebTerminalView stabilizes sendResize and safeFit dependencies and UnifiedTerminalView memoizes handleHostChange', () => {
    // sendResize must not re-trigger on mobile viewport changes
    expect(webTerminalContent).toMatch(/const sendResize = useCallback\([\s\S]*?\},\s*\[\]\);/);
    // safeFit must only depend on sendResize and not re-trigger on viewport/standalone shifts
    expect(webTerminalContent).toMatch(/const safeFit = useCallback\([\s\S]*?\},\s*\[sendResize\]\);/);
    // handleHostChange in UnifiedTerminalView must be memoized
    expect(unifiedContent).toMatch(/const handleHostChange = useCallback\(\(newHostId: string\) =>/);
  });

  it('terminalWs sets TCP keepalive on underlying HTTP upgrade sockets', () => {
    const wsRoutePath = path.resolve(__dirname, '../src/terminal/routes/terminalWs.ts');
    const wsRouteContent = fs.readFileSync(wsRoutePath, 'utf-8');
    expect(wsRouteContent).toMatch(/setKeepAlive\(true,\s*10000\)/);
  });
});
