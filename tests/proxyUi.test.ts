import * as fs from 'fs';
import * as path from 'path';

describe('Frontend TerminalProxyView & UnifiedTerminalView Integration (Phase 2)', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  const proxyViewPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalProxyView.tsx');
  const enLocalePath = path.resolve(__dirname, '../frontend/src/i18n/locales/en.ts');
  const zhLocalePath = path.resolve(__dirname, '../frontend/src/i18n/locales/zh.ts');

  it('verifies UnifiedTerminalView.tsx integrates proxy sub-tab', () => {
    expect(fs.existsSync(unifiedPath)).toBe(true);
    const content = fs.readFileSync(unifiedPath, 'utf-8');

    // TerminalSubTab union
    expect(content).toMatch(/type\s+TerminalSubTab\s*=\s*['"]interactive['"]\s*\|\s*['"]files['"]\s*\|\s*['"]cron['"]\s*\|\s*['"]tasks['"]\s*\|\s*['"]proxy['"]/);

    // Imports TerminalProxyView & Globe icon
    expect(content).toContain('TerminalProxyView');
    expect(content).toMatch(/import\s*\{[^}]*Globe[^}]*\}\s*from\s*['"]lucide-react['"]/);

    // Sub-tab button with testid
    expect(content).toContain('data-testid="subtab-proxy"');
    expect(content).toContain("handleSubTabChange('proxy')");

    // Top-bar refresh button
    expect(content).toContain("subTab === 'proxy'");
    expect(content).toContain('proxyRef.current?.refresh()');

    // Workspace mounting
    expect(content).toContain('<TerminalProxyView');
    expect(content).toContain("subTab === 'proxy' ? 'flex' : 'hidden'");
  });

  it('verifies TerminalProxyView.tsx exists and implements port and request modes', () => {
    expect(fs.existsSync(proxyViewPath)).toBe(true);
    const content = fs.readFileSync(proxyViewPath, 'utf-8');

    // Handle interface and component export
    expect(content).toContain('export interface TerminalProxyHandle');
    expect(content).toContain('export const TerminalProxyView');

    // Port discovery and proxy routes
    expect(content).toContain('/api/proxy/');
    expect(content).toContain('/ports');
    expect(content).toContain('/api/auth/ticket');
    expect(content).toContain('x-gt-target-url');

    // Interactive buttons & elements testids
    expect(content).toContain('data-testid="proxy-load-preview-btn"');
    expect(content).toContain('data-testid="proxy-open-tab-btn"');
    expect(content).toContain('data-testid="proxy-copy-forward-btn"');
    expect(content).toContain('data-testid="proxy-request-url-input"');
    expect(content).toContain('data-testid="proxy-send-request-btn"');
    expect(content).toContain('data-testid="proxy-preview-iframe"');

    // Query parameters _gt_host and _gt_proto
    expect(content).toContain('_gt_host');
    expect(content).toContain('_gt_proto');

    // Empty state fallback
    expect(content).toContain('TerminalEmptyState');

    // Speedtest mode tab & controls
    expect(content).toMatch(/['"]port['"]\s*\|\s*['"]request['"]\s*\|\s*['"]speedtest['"]/);
    expect(content).toContain('data-testid="proxy-mode-speedtest"');
    expect(content).toContain('data-testid="speedtest-size-select"');
    expect(content).toContain('data-testid="speedtest-start-btn"');
    expect(content).toContain('/speedtest/ping');
    expect(content).toContain('/speedtest/download');
    expect(content).toContain('/speedtest/upload');
    expect(content).toContain('/speedtest/probe');
    expect(content).toContain('data-testid="speedtest-custom-probe-input"');
    expect(content).toContain('data-testid="speedtest-probe-btn"');
  });

  it('verifies i18n locales have proxy translations', () => {
    const enContent = fs.readFileSync(enLocalePath, 'utf-8');
    const zhContent = fs.readFileSync(zhLocalePath, 'utf-8');

    expect(enContent).toContain('proxy:');
    expect(zhContent).toContain('proxy:');

    expect(enContent).toContain('portMode:');
    expect(zhContent).toContain('portMode:');

    expect(enContent).toContain('requestMode:');
    expect(zhContent).toContain('requestMode:');

    expect(enContent).toContain('speedtestMode:');
    expect(zhContent).toContain('speedtestMode:');
  });
});
