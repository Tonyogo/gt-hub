import fs from 'fs';
import path from 'path';
import { en } from '../frontend/src/i18n/locales/en';
import { zh } from '../frontend/src/i18n/locales/zh';

describe('TerminalHostSelector Pure Agent Tests', () => {
  const selectorPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalHostSelector.tsx');
  const content = fs.readFileSync(selectorPath, 'utf-8');

  test('does not hardcode localHostFallback object with localhost', () => {
    expect(content).not.toContain('localHostFallback');
  });

  test('uses stable my-server name instead of random worker suffix in agentCommand', () => {
    expect(content).toContain('--name="my-server"');
    expect(content).not.toMatch(/worker-\$\{Math\.floor/);
  });

  test('auto selects first online host when current host is absent', () => {
    expect(content).toContain('onSelectHost');
  });

  test('i18n locales contain multi-host and empty state translations', () => {
    expect((en as any).webTerminal.hostSelector).toBeDefined();
    expect((zh as any).webTerminal.hostSelector).toBeDefined();
    expect((en as any).webTerminal.emptyState).toBeDefined();
    expect((zh as any).webTerminal.emptyState).toBeDefined();
    expect((zh as any).webTerminal.emptyState.title).toContain('在线终端节点');
  });

  test('uses createPortal to mount add node guide modal to document.body avoiding container clipping', () => {
    expect(content).toContain('createPortal');
    expect(content).toContain('document.body');
  });

  test('guards against wiping activeHostId before initial fetch completes', () => {
    expect(content).toContain('hasLoadedRef');
    expect(content).toContain('cached_terminal_hosts');
  });

  test('uses createPortal to mount host dropdown popover to document.body preventing overflow clipping', () => {
    expect(content).toContain('dropdownPortal');
    // Ensure dropdown popover itself is mounted via createPortal
    expect(content).toMatch(/createPortal\s*\(\s*[\s\S]*popoverContent[\s\S]*document\.body\s*\)/);
  });

  test('renders clear offline hosts button when offline hosts exist', () => {
    expect(content).toContain('/api/terminal/hosts/offline');
    expect(content).toContain('hasOfflineHosts');
  });

  test('formats and displays offline relative time for offline hosts', () => {
    expect(content).toContain('formatRelativeTime');
  });

  test('supports filtering offline hosts and persists state in localStorage', () => {
    expect(content).toContain('terminal_hide_offline_hosts');
    expect(content).toContain('hideOffline');
  });

  test('sorts filtered hosts with online first and alphabetical order', () => {
    expect(content).toContain('localeCompare');
  });

  test('i18n locales contain offline filter translations', () => {
    expect((zh as any).webTerminal.hostSelector.showOnlyOnline).toBeDefined();
    expect((en as any).webTerminal.hostSelector.showOnlyOnline).toBeDefined();
    expect((zh as any).webTerminal.hostSelector.showAllHosts).toBeDefined();
    expect((en as any).webTerminal.hostSelector.showAllHosts).toBeDefined();
  });

  test('modal splits guide into Step 1 (install CLI) and Step 2 (connect & run agent) with distinct copy buttons', () => {
    expect(content).toContain('installCommand');
    expect(content).toContain('agentCommand');
    expect(content).toContain('handleCopyInstall');
    expect(content).toContain('handleCopyCommand');
    expect(content).toContain('copyToClipboard');
    expect(content).toContain('fallbackCopy');
    expect(content).toContain('/install.sh');
    expect(content).toContain('gt login');
    expect(content).toContain('step1InstallTitle');
    expect(content).toContain('step2RunTitle');
    expect(content).toContain('installRequirements');
    expect(content).toContain('autoConnectTip');
  });

  test('i18n locales contain step1, step2, copyInstallCommand and copyRunCommand translations', () => {
    expect((zh as any).webTerminal.hostSelector.step1InstallTitle).toBeDefined();
    expect((en as any).webTerminal.hostSelector.step1InstallTitle).toBeDefined();
    expect((zh as any).webTerminal.hostSelector.step2RunTitle).toBeDefined();
    expect((en as any).webTerminal.hostSelector.step2RunTitle).toBeDefined();
    expect((zh as any).webTerminal.hostSelector.copyInstallCommand).toBeDefined();
    expect((en as any).webTerminal.hostSelector.copyInstallCommand).toBeDefined();
    expect((zh as any).webTerminal.hostSelector.copyRunCommand).toBeDefined();
    expect((en as any).webTerminal.hostSelector.copyRunCommand).toBeDefined();
    expect((zh as any).webTerminal.hostSelector.installRequirements).toBeDefined();
    expect((en as any).webTerminal.hostSelector.installRequirements).toBeDefined();
    expect((zh as any).webTerminal.hostSelector.autoConnectTip).toBeDefined();
    expect((en as any).webTerminal.hostSelector.autoConnectTip).toBeDefined();
  });
});
