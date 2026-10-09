import * as fs from 'fs';
import * as path from 'path';

describe('UnifiedTerminalView Micro Top Bar Integrated Controls', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('UnifiedTerminalView imports and uses Github, Languages, Sun, Moon icons', () => {
    expect(content).toMatch(/import\s*\{[^}]*\bGithub\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(content).toMatch(/import\s*\{[^}]*\bLanguages\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(content).toMatch(/import\s*\{[^}]*\bSun\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(content).toMatch(/import\s*\{[^}]*\bMoon\b[^}]*\}\s*from\s*'lucide-react'/);
  });

  it('UnifiedTerminalView imports and uses useTheme hook', () => {
    expect(content).toMatch(/import\s*\{[^}]*\buseTheme\b[^}]*\}\s*from\s*'\.\.\/theme\/ThemeContext'/);
    expect(content).toContain('useTheme()');
  });

  it('UnifiedTerminalView manages adminKey state with localStorage fallback', () => {
    expect(content).toContain("localStorage.getItem('admin_secret_key')");
  });

  it('UnifiedTerminalView provides default isStandalone=true prop', () => {
    expect(content).toMatch(/isStandalone\s*=\s*true/);
  });
});
