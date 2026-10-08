import fs from 'fs';
import path from 'path';

describe('Terminal Mobile Layout Responsiveness', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const terminalLogsPath = path.resolve(__dirname, '../frontend/src/components/TerminalLogsView.tsx');

  test('WebTerminalView contains mobile responsive classes for tabs, status, and zoom controls', () => {
    const content = fs.readFileSync(webTerminalPath, 'utf-8');

    // 1. Tab labels are hidden on mobile
    expect(content).toContain("<span className=\"hidden sm:inline\">{t('terminal.interactiveTab')}</span>");
    expect(content).toContain("<span className=\"hidden sm:inline\">{t('terminal.logsTab')}</span>");

    // 2. Tab button padding is compact on mobile
    expect(content).toContain('px-2 sm:px-2.5 py-1');

    // 3. Status text is hidden on mobile, leaving only status indicator dot
    expect(content).toContain('<span className="hidden sm:inline text-[10px]">');

    // 4. Zoom in and out buttons are hidden on mobile
    expect(content).toMatch(/className="[^"]*hidden sm:inline-flex[^"]*"[^>]*title="Zoom Out"/);
    expect(content).toMatch(/className="[^"]*hidden sm:inline-flex[^"]*"[^>]*title="Zoom In"/);
  });

  test('TerminalLogsView contains mobile responsive classes aligned with WebTerminalView', () => {
    const content = fs.readFileSync(terminalLogsPath, 'utf-8');

    // 1. Tab labels are hidden on mobile
    expect(content).toContain("<span className=\"hidden sm:inline\">{t('terminal.interactiveTab')}</span>");
    expect(content).toContain("<span className=\"hidden sm:inline\">{t('terminal.logsTab')}</span>");

    // 2. Tab button padding matches WebTerminalView
    expect(content).toContain('px-2 sm:px-2.5 py-1');

    // 3. Status badge text is hidden on mobile
    expect(content).toContain('<span className="hidden sm:inline tracking-wider uppercase">');
  });
});
