import fs from 'fs';
import path from 'path';

describe('Terminal Font Size Mobile Adaptation Tests', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const content = fs.readFileSync(webTerminalPath, 'utf-8');

  test('WebTerminalView initializes mobile default font size to 11px and desktop to 13px', () => {
    // Should distinguish mobile vs desktop default font size
    expect(content).toMatch(/11\s*:\s*13/);
    expect(content).toContain('terminal_font_size_mobile');
    expect(content).toContain('terminal_font_size');
  });

  test('WebTerminalView persists font size under device-specific localStorage key', () => {
    expect(content).toMatch(/localStorage\.setItem\(\s*(?:isMobile\s*\?\s*'terminal_font_size_mobile'\s*:\s*'terminal_font_size'|storageKey)/);
  });
});
