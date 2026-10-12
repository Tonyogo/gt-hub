import * as fs from 'fs';
import * as path from 'path';

describe('Frontend HTTP Interception and Toast Notification Standards', () => {
  const unifiedTerminalPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  const fileManagerPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalFileManagerView.tsx');

  let unifiedContent: string;
  let fileManagerContent: string;

  beforeAll(() => {
    unifiedContent = fs.readFileSync(unifiedTerminalPath, 'utf-8');
    fileManagerContent = fs.readFileSync(fileManagerPath, 'utf-8');
  });

  it('UnifiedTerminalView does not monkey-patch window.fetch', () => {
    expect(unifiedContent).not.toContain('window.fetch =');
    expect(unifiedContent).toContain('onUnauthorized');
  });

  it('TerminalFileManagerView has no raw alert() calls', () => {
    // Regex matching alert(...) call but not properties like savedAlert
    const alertCalls = fileManagerContent.match(/(?<![a-zA-Z0-9_.])alert\s*\(/g);
    expect(alertCalls).toBeNull();
  });

  it('TerminalFileManagerView renders toast notifications and uses apiFetch', () => {
    expect(fileManagerContent).toContain('apiFetch');
    expect(fileManagerContent).toContain('showToast');
    expect(fileManagerContent).toContain('Toast Notifications');
  });
});
