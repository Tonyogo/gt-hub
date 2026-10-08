import * as fs from 'fs';
import * as path from 'path';

describe('App.tsx Pure Fullscreen Terminal Architecture', () => {
  const appPath = path.resolve(__dirname, '../frontend/src/App.tsx');
  let appContent: string;

  beforeAll(() => {
    appContent = fs.readFileSync(appPath, 'utf-8');
  });

  it('App.tsx does not import or render TerminalLogsView', () => {
    expect(appContent).not.toContain('TerminalLogsView');
    expect(appContent).not.toContain('terminal.logsTab');
  });

  it('App.tsx does not render outer header or gt-hub title bar', () => {
    expect(appContent).not.toMatch(/<header[^>]*>/);
    expect(appContent).not.toContain('gt-hub');
    expect(appContent).not.toContain('activeTab');
  });

  it('App.tsx renders UnifiedTerminalView with full screen container', () => {
    expect(appContent).toContain('<UnifiedTerminalView');
    expect(appContent).toContain('h-[100dvh]');
  });
});
