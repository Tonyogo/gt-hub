import * as fs from 'fs';
import * as path from 'path';

describe('Enterprise Light & Dark Theme System Architecture', () => {
  const indexCssPath = path.resolve(__dirname, '../frontend/src/index.css');
  const tailwindConfigPath = path.resolve(__dirname, '../frontend/tailwind.config.js');

  test('index.css defines complete Light and Dark semantic surface, text, and border tokens', () => {
    const css = fs.readFileSync(indexCssPath, 'utf-8');
    const requiredTokens = [
      '--bg-canvas:',
      '--bg-surface:',
      '--bg-surface-sub:',
      '--bg-elevated:',
      '--bg-terminal:',
      '--bg-control:',
      '--bg-control-hover:',
      '--bg-overlay:',
      '--text-primary:',
      '--text-secondary:',
      '--text-muted:',
      '--border-subtle:',
      '--border-default:',
      '--border-hover:',
      '--border-focus:',
    ];
    for (const token of requiredTokens) {
      expect(css).toContain(token);
    }
    // Verify Dark canvas is #090D16 and Light canvas is #F8FAFC
    expect(css).toContain('#090D16');
    expect(css).toContain('#F8FAFC');
  });

  test('index.css removes the brittle :root:not(.dark) slate/border override hack and purple button gradient', () => {
    const css = fs.readFileSync(indexCssPath, 'utf-8');
    expect(css).not.toContain('.border-white\\/\\[0\\.08\\]');
    expect(css).not.toContain('to-purple-600');
    expect(css).toContain('.ui-elevated');
    expect(css).toContain('.ui-icon-btn');
    expect(css).toContain('.ansi-log-container');
  });

  test('tailwind.config.js extends semantic colors mapped to CSS variables', () => {
    const config = fs.readFileSync(tailwindConfigPath, 'utf-8');
    expect(config).toContain('var(--bg-canvas)');
    expect(config).toContain('var(--bg-surface)');
    expect(config).toContain('var(--bg-elevated)');
    expect(config).toContain('var(--bg-terminal)');
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
});
