import * as fs from 'fs';
import * as path from 'path';

describe('Frontend AuthContext Architecture', () => {
  const authContextPath = path.resolve(__dirname, '../frontend/src/auth/AuthContext.tsx');

  let content: string;
  beforeAll(() => {
    content = fs.readFileSync(authContextPath, 'utf-8');
  });

  it('exports AuthProvider and useAuth hook', () => {
    expect(content).toContain('export function AuthProvider');
    expect(content).toContain('export function useAuth');
  });

  it('manages checking, authenticated, and unauthenticated status', () => {
    expect(content).toContain("'checking'");
    expect(content).toContain("'authenticated'");
    expect(content).toContain("'unauthenticated'");
  });

  it('probes /api/auth/status on initialization', () => {
    expect(content).toContain('/api/auth/status');
    expect(content).toContain('admin_secret_key');
  });

  it('clears session and local storage on logout', () => {
    expect(content).toContain("localStorage.removeItem('admin_secret_key')");
    expect(content).toContain("sessionStorage.removeItem('cached_terminal_hosts')");
  });
});
