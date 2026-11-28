import * as fs from 'fs';
import * as path from 'path';

describe('Enterprise Light & Dark Theme System Architecture', () => {
  const indexCssPath = path.resolve(__dirname, '../frontend/src/index.css');
  const tailwindConfigPath = path.resolve(__dirname, '../frontend/tailwind.config.js');

  describe('Obsidian Azure Foundation Tokens & Fonts', () => {
    test('index.css defines complete Obsidian Azure Light & Dark tokens and primitives', () => {
      const css = fs.readFileSync(indexCssPath, 'utf-8');
      const requiredTokens = [
        '--font-sans:', '--font-mono:',
        '--bg-canvas: #f5f6f8;', '--bg-sidebar: #fafbfc;', '--bg-surface: #ffffff;', '--bg-surface-sub: #f8f9fb;',
        '--bg-canvas: #07080a;', '--bg-sidebar: #0b0d11;', '--bg-surface: #101216;', '--bg-surface-sub: #161920;',
        '--cta-bg: #111318;', '--cta-bg: #f4f6f9;', '--cta-text: #09090b;',
        '--accent-primary: #2563eb;', '--accent-primary: #3b82f6;',
        '--status-success-text: #047857;', '--status-success-text: #34d399;',
        '--status-warning-text: #92400e;', '--status-warning-text: #fbbf24;',
        '--status-danger-text: #be123c;', '--status-danger-text: #fb7185;',
        '--status-info-text: #0369a1;', '--status-info-text: #38bdf8;',
        '--shadow-card:', '--shadow-popover:',
      ];
      for (const token of requiredTokens) {
        expect(css).toContain(token);
      }
      const requiredPrimitives = [
        '.ui-card', '.ui-card-interactive', '.ui-btn-primary', '.ui-btn-secondary',
        '.ui-ambient-stage', '.ui-row-indicator', '.ui-modal-shell', '.ui-composer-shell',
        '.ui-tab-underline', '.ui-tab-underline-active',
        '.ui-badge-success', '.ui-badge-warning', '.ui-badge-danger', '.ui-badge-info', '.ui-badge-neutral',
        '.ui-elevated-glass', '.ui-surface-glass',
      ];
      for (const cls of requiredPrimitives) {
        expect(css).toContain(cls);
      }
      expect(css).toContain('color-mix(in srgb');
      expect(css).toContain(':not(.xterm-helper-textarea)');
      expect(css).toContain('font-size: 16px !important');
      expect(css).toContain('prefers-reduced-motion: reduce');
      expect(css).not.toContain('indigo-');
      expect(css).not.toContain('slate-');
    });

    test('frontend self-hosts @fontsource-variable/inter and @fontsource-variable/jetbrains-mono', () => {
      const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../frontend/package.json'), 'utf-8'));
      const mainTsx = fs.readFileSync(path.resolve(__dirname, '../frontend/src/main.tsx'), 'utf-8');
      const twConfig = fs.readFileSync(tailwindConfigPath, 'utf-8');
      expect(pkg.dependencies['@fontsource-variable/inter']).toBeDefined();
      expect(pkg.dependencies['@fontsource-variable/jetbrains-mono']).toBeDefined();
      expect(mainTsx).toContain("@fontsource-variable/inter");
      expect(mainTsx).toContain("@fontsource-variable/jetbrains-mono");
      expect(twConfig).toContain('var(--font-sans)');
      expect(twConfig).toContain('var(--font-mono)');
      expect(twConfig).toContain('var(--bg-sidebar)');
    });
  });

  test('App.tsx and LoginView.tsx use Indigo as primary brand accent instead of Emerald', () => {
    const appContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/App.tsx'), 'utf-8');
    const loginContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/components/LoginView.tsx'), 'utf-8');

    expect(appContent).toContain('text-indigo-500');
    expect(loginContent).toContain('bg-indigo-600');
    expect(loginContent).not.toContain('bg-emerald-600');
  });

  test('monacoTheme.ts aligns dark editor background with #090D16 and light editor background with #FFFFFF', () => {
    const monacoContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/utils/monacoTheme.ts'), 'utf-8');
    expect(monacoContent).toContain('#090D16');
    expect(monacoContent).toContain('#FFFFFF');
  });

  test('markdownRenderer.ts uses semantic CSS variables instead of hardcoded dark slate classes', () => {
    const mdContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/utils/markdownRenderer.ts'), 'utf-8');
    expect(mdContent).toContain('var(--text-primary)');
    expect(mdContent).toContain('var(--code-bg)');
    expect(mdContent).not.toContain('bg-black/20');
  });

  test('WebTerminalView defines calibrated DARK_TERMINAL_THEME (#090D16) and LIGHT_TERMINAL_THEME (#FFFFFF) and UnifiedTerminalView removes hardcoded #18181b menu', () => {
    const webTermContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx'), 'utf-8');
    const unifiedContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx'), 'utf-8');

    expect(webTermContent).toContain("background: '#090D16'");
    expect(webTermContent).toContain("background: '#FFFFFF'");
    expect(webTermContent).not.toContain('bg-[#160E12]');
    expect(unifiedContent).not.toContain('bg-[#18181b]');
    expect(unifiedContent).not.toContain('border-[#27272a]');
  });

  test('Cron, Task views, Modals, and ScriptDrawer contain no hardcoded dark hex backgrounds (#121316, #18181b, #0c1017, #090d16, #121214)', () => {
    const filesToCheck = [
      '../frontend/src/components/terminal/TerminalCronView.tsx',
      '../frontend/src/components/terminal/TerminalTaskView.tsx',
      '../frontend/src/components/terminal/components/CronJobModal.tsx',
      '../frontend/src/components/terminal/components/CronLogModal.tsx',
      '../frontend/src/components/terminal/components/CreateTaskModal.tsx',
      '../frontend/src/components/terminal/components/TaskLogModal.tsx',
      '../frontend/src/components/terminal/TerminalScriptDrawer.tsx',
    ];

    for (const relPath of filesToCheck) {
      const content = fs.readFileSync(path.resolve(__dirname, relPath), 'utf-8');
      expect(content).not.toMatch(/#(121316|18181b|0c1017|090d16|121214)/i);
    }
  });

  test('FileManager, Image/PDF Preview Modals, and ProxyView use semantic surface/elevated tokens instead of hardcoded bg-slate-900/bg-zinc-900 modal shells', () => {
    const fileManagerContent = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/terminal/TerminalFileManagerView.tsx'),
      'utf-8'
    );
    const imageModalContent = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/terminal/TerminalImagePreviewModal.tsx'),
      'utf-8'
    );
    const pdfModalContent = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/terminal/TerminalPdfPreviewModal.tsx'),
      'utf-8'
    );
    const proxyContent = fs.readFileSync(
      path.resolve(__dirname, '../frontend/src/components/terminal/TerminalProxyView.tsx'),
      'utf-8'
    );

    expect(fileManagerContent).toContain('var(--bg-surface)');
    expect(imageModalContent).toContain('var(--bg-elevated)');
    expect(pdfModalContent).toContain('var(--bg-elevated)');
    expect(proxyContent).toContain('var(--bg-surface)');
    expect(proxyContent).not.toContain('bg-slate-950');
  });
});
