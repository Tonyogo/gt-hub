import * as fs from 'fs';
import * as path from 'path';

describe('LoginView Component Architecture', () => {
  const loginViewPath = path.resolve(__dirname, '../frontend/src/components/LoginView.tsx');

  let content: string;
  beforeAll(() => {
    content = fs.readFileSync(loginViewPath, 'utf-8');
  });

  it('renders a full screen flex container', () => {
    expect(content).toContain('h-[100dvh]');
    expect(content).toContain('w-screen');
  });

  it('includes secret key input with autoFocus and password type', () => {
    expect(content).toContain('autoFocus');
    expect(content).toContain('type=');
    expect(content).toContain('password');
  });

  it('integrates language and theme toggles in the login header', () => {
    expect(content).toContain('useTheme');
    expect(content).toContain('useTranslation');
    expect(content).toContain('Languages');
    expect(content).toMatch(/Sun|Moon/);
  });

  it('submits form via useAuth().login', () => {
    expect(content).toContain('useAuth()');
    expect(content).toContain('login(');
  });

  it('uses Obsidian Azure primitives, embedded shell visibility, and zero legacy indigo/slate classes', () => {
    expect(content).toContain('ui-ambient-stage');
    expect(content).toContain('ui-card');
    expect(content).toContain('ui-btn-primary');
    expect(content).toContain('getEmbeddedShellVisibility');
    expect(content).not.toMatch(/\bindigo-\d+/);
    expect(content).not.toMatch(/\bslate-\d+/);
  });
});
