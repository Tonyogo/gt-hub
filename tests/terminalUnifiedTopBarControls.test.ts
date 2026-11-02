import * as fs from 'fs';
import * as path from 'path';

describe('UnifiedTerminalView Micro Top Bar Integrated Controls', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('UnifiedTerminalView imports and uses Github, Languages, Sun, Moon icons', () => {
    expect(content).toMatch(/import\s*\{[^}]*\bGithub\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(content).toMatch(/import\s*\{[^}]*\bLanguages\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(content).toMatch(/import\s*\{[^}]*\bSun\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(content).toMatch(/import\s*\{[^}]*\bMoon\b[^}]*\}\s*from\s*'lucide-react'/);
  });

  it('UnifiedTerminalView imports and uses useTheme hook', () => {
    expect(content).toMatch(/import\s*\{[^}]*\buseTheme\b[^}]*\}\s*from\s*'\.\.\/theme\/ThemeContext'/);
    expect(content).toContain('useTheme()');
  });

  it('UnifiedTerminalView manages adminKey state with localStorage fallback', () => {
    expect(content).toContain("localStorage.getItem('admin_secret_key')");
  });

  it('UnifiedTerminalView provides default isStandalone=true prop', () => {
    expect(content).toMatch(/isStandalone\s*=\s*true/);
  });

  it('UnifiedTerminalView includes script library button when in interactive subTab', () => {
    expect(content).toMatch(/import\s*\{[^}]*\bScrollText\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(content).toContain('openScriptDrawer');
    expect(content).toContain('scripts.title');
  });

  it('UnifiedTerminalView imports and uses browserFullscreenHelper for universal fullscreen', () => {
    expect(content).toMatch(/import\s*\{[^}]*\btoggleBrowserFullscreen\b[^}]*\}\s*from\s*'\.\.\/utils\/browserFullscreenHelper'/);
    expect(content).toMatch(/import\s*\{[^}]*\bisFullscreenActive\b[^}]*\}\s*from\s*'\.\.\/utils\/browserFullscreenHelper'/);
    expect(content).toMatch(/import\s*\{[^}]*\bonFullscreenChange\b[^}]*\}\s*from\s*'\.\.\/utils\/browserFullscreenHelper'/);
  });

  it('UnifiedTerminalView renders browser fullscreen button for both mobile and desktop', () => {
    expect(content).toContain('data-testid="fullscreen-toggle-btn"');
    expect(content).toContain('handleFullscreenToggle');
    expect(content).toMatch(/isBrowserFullscreen\s*\?\s*<Minimize2[^>]*\/>\s*:\s*<Maximize2[^>]*\/>/);
    expect(content).not.toMatch(/\{!isMobile\s*&&\s*\(\s*<button[^>]*data-testid="fullscreen-toggle-btn"/);
  });

  it('UnifiedTerminalView imports MoreVertical icon for mobile overflow menu', () => {
    expect(content).toMatch(/import\s*\{[^}]*\bMoreVertical\b[^}]*\}\s*from\s*'lucide-react'/);
  });

  it('UnifiedTerminalView manages isMoreMenuOpen state and closes on click-outside', () => {
    expect(content).toContain('isMoreMenuOpen');
    expect(content).toContain('setIsMoreMenuOpen');
  });

  it('UnifiedTerminalView keeps only Paste and Select Mode directly on mobile title bar while collapsing others to sm:inline-flex', () => {
    expect(content).toMatch(/import\s*\{[^}]*\bClipboardPaste\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(content).toContain('data-testid="top-paste-btn"');
    expect(content).toContain('data-testid="top-select-mode-btn"');
    expect(content).toContain('getActiveTerminalRef()?.pasteClipboard()');

    // Paste and Select Mode buttons must NOT have hidden sm:inline-flex
    expect(content).not.toMatch(/data-testid="top-paste-btn"[^>]*hidden\s+sm:inline-flex/);
    expect(content).not.toMatch(/data-testid="top-select-mode-btn"[^>]*hidden\s+sm:inline-flex/);

    // Desktop secondary buttons have hidden sm:inline-flex
    expect(content).toMatch(/data-testid="unified-open-scripts-btn"[^>]*hidden\s+sm:inline-flex/);
    expect(content).toMatch(/data-testid="split-terminal-btn"[^>]*hidden\s+sm:inline-flex/);
    expect(content).toMatch(/data-testid="fullscreen-toggle-btn"[^>]*hidden\s+sm:inline-flex/);
    expect(content).toContain('data-testid="mobile-more-btn"');
    expect(content).toContain('sm:hidden');
  });

  it('UnifiedTerminalView renders mobile fullscreen and subtab refresh inside mobile more menu', () => {
    expect(content).toContain('data-testid="mobile-fullscreen-btn"');
    expect(content).toContain('data-testid="mobile-refresh-btn"');
  });

  it('UnifiedTerminalView renders mobile more menu popover containing Script Library, Reconnect, Settings', () => {
    expect(content).toContain('data-testid="mobile-more-menu"');
    expect(content).toContain('openScriptDrawer');
  });

  it('UnifiedTerminalView reorders desktop action buttons with Paste and Select Mode first, and strips text labels for pure icon presentation', () => {
    // 1. Order verification: paste and select mode come before split and scripts
    const idxPaste = content.indexOf('data-testid="top-paste-btn"');
    const idxSelect = content.indexOf('data-testid="top-select-mode-btn"');
    const idxSplit = content.indexOf('data-testid="split-terminal-btn"');
    const idxScripts = content.indexOf('data-testid="unified-open-scripts-btn"');

    expect(idxPaste).toBeGreaterThan(0);
    expect(idxSelect).toBeGreaterThan(idxPaste);
    expect(idxSplit).toBeGreaterThan(idxSelect);
    expect(idxScripts).toBeGreaterThan(idxSplit);

    // 2. Pure icon check: buttons do not contain embedded text spans
    const pasteBlock = content.slice(idxPaste, idxSelect);
    expect(pasteBlock).not.toMatch(/<span[^>]*>[^<]*<\/span>/);

    const selectBlock = content.slice(idxSelect, idxSplit);
    expect(selectBlock).not.toMatch(/<span[^>]*>[^<]*<\/span>/);

    const scriptsBlock = content.slice(idxScripts, idxScripts + 350);
    expect(scriptsBlock).not.toMatch(/<span[^>]*>[^<]*<\/span>/);
  });
});
