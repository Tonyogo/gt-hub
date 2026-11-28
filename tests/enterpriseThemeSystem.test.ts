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

  function collectFiles(dir: string, exts: string[]): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...collectFiles(fullPath, exts));
      } else if (exts.some((ext) => entry.name.endsWith(ext))) {
        results.push(fullPath);
      }
    }
    return results;
  }

  test('index.html has Anti-FOUC script and frontend contains zero Google Fonts CDN links', () => {
    const indexHtml = fs.readFileSync(path.resolve(__dirname, '../frontend/index.html'), 'utf-8');
    expect(indexHtml).toContain('app_hub_theme_mode');
    expect(indexHtml).toContain('#07080a');
    expect(indexHtml).toContain('#f5f6f8');
    expect(indexHtml).not.toContain('fonts.googleapis.com');
    expect(indexHtml).not.toContain('fonts.gstatic.com');

    const srcFiles = collectFiles(path.resolve(__dirname, '../frontend/src'), ['.ts', '.tsx', '.css']);
    for (const file of srcFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      expect(content).not.toContain('fonts.googleapis.com');
      expect(content).not.toContain('fonts.gstatic.com');
    }
  });

  test('frontend/src contains zero indigo-*, slate-*, CSS-var opacity modifiers, or ui-btn-primary + text-white collisions', () => {
    const srcFiles = collectFiles(path.resolve(__dirname, '../frontend/src'), ['.ts', '.tsx', '.css']);
    const violations: string[] = [];

    for (const file of srcFiles) {
      const rel = path.relative(path.resolve(__dirname, '..'), file);
      const content = fs.readFileSync(file, 'utf-8');

      if (/\bindigo-\d+/.test(content)) {
        violations.push(`${rel}: contains forbidden indigo-* class`);
      }
      if (/\bslate-\d+/.test(content)) {
        violations.push(`${rel}: contains forbidden slate-* class`);
      }
      if (/(?:bg|border|text)-\[var\(--[^\]]+\)\]\//.test(content)) {
        violations.push(`${rel}: contains forbidden CSS-var opacity modifier`);
      }

      const classAttrMatches = content.match(/className=(?:"[^"]*"|\{`[^`]*`\})/g) || [];
      for (const match of classAttrMatches) {
        if (/\bui-btn-primary\b/.test(match) && /\btext-white\b/.test(match)) {
          violations.push(`${rel}: combines ui-btn-primary with text-white`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test('Terminal, Monaco, App, LoginView, and Markdown use Obsidian Azure surface and accent tokens', () => {
    const webTermContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx'), 'utf-8');
    const monacoContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/utils/monacoTheme.ts'), 'utf-8');
    const appContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/App.tsx'), 'utf-8');
    const loginContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/components/LoginView.tsx'), 'utf-8');
    const mdContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/utils/markdownRenderer.ts'), 'utf-8');

    expect(webTermContent.toLowerCase()).toContain("background: '#07080a'");
    expect(webTermContent.toLowerCase()).toContain("background: '#ffffff'");
    expect(webTermContent).not.toContain('bg-[#160E12]');

    expect(monacoContent.toLowerCase()).toContain("'#0b0d11'");
    expect(monacoContent.toLowerCase()).toContain("'#ffffff'");

    expect(appContent).toContain('text-[var(--accent-primary)]');
    expect(loginContent).toContain('ui-btn-primary');
    expect(loginContent).not.toContain('bg-emerald-600');

    expect(mdContent).toContain('var(--text-primary)');
    expect(mdContent).toContain('var(--code-bg)');
    expect(mdContent).not.toContain('bg-black/20');
  });

  test('All modal-bearing components use ModalShell and zero raw fixed inset-0 z-50 wrappers', () => {
    const modalFiles = [
      '../frontend/src/components/terminal/components/CreateTaskModal.tsx',
      '../frontend/src/components/terminal/components/CronJobModal.tsx',
      '../frontend/src/components/terminal/components/CronLogModal.tsx',
      '../frontend/src/components/terminal/components/TaskLogModal.tsx',
      '../frontend/src/components/terminal/TerminalScriptDrawer.tsx',
      '../frontend/src/components/terminal/TerminalImagePreviewModal.tsx',
      '../frontend/src/components/terminal/TerminalPdfPreviewModal.tsx',
      '../frontend/src/components/terminal/TerminalHostSelector.tsx',
      '../frontend/src/components/terminal/TerminalFileManagerView.tsx',
    ];

    for (const relPath of modalFiles) {
      const content = fs.readFileSync(path.resolve(__dirname, relPath), 'utf-8');
      expect(content).toContain('ModalShell');
      expect(content).not.toMatch(/fixed inset-0 z-50/);
    }
  });
});
