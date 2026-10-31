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
});
