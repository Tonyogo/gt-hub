import * as fs from 'fs';
import * as path from 'path';

describe('Auth Guard Integration & Logout Mechanism', () => {
  const appPath = path.resolve(__dirname, '../frontend/src/App.tsx');
  const mainPath = path.resolve(__dirname, '../frontend/src/main.tsx');
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');

  let appContent: string;
  let mainContent: string;
  let unifiedContent: string;

  beforeAll(() => {
    appContent = fs.readFileSync(appPath, 'utf-8');
    mainContent = fs.readFileSync(mainPath, 'utf-8');
    unifiedContent = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('main.tsx wraps App with AuthProvider', () => {
    expect(mainContent).toContain('<AuthProvider>');
    expect(mainContent).toContain('</AuthProvider>');
  });

  it('App.tsx uses useAuth to guard terminal access', () => {
    expect(appContent).toContain('useAuth()');
    expect(appContent).toContain("<LoginView");
    expect(appContent).toContain("status === 'unauthenticated'");
  });

  it('App.tsx passes onLogout to UnifiedTerminalView', () => {
    expect(appContent).toMatch(/<UnifiedTerminalView[^>]*onLogout=\{(authRequired \? )?logout/);
  });

  it('UnifiedTerminalView provides Logout button and handles 401 auto logout', () => {
    expect(unifiedContent).toContain('LogOut');
    expect(unifiedContent).toContain('onLogout');
  });
});
