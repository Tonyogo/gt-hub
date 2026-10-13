import * as fs from 'fs';
import * as path from 'path';

describe('WebTerminalView Script Integration', () => {
  const terminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(terminalPath, 'utf-8');
  });

  it('imports TerminalScriptDrawer and ScrollText icon', () => {
    expect(content).toContain('TerminalScriptDrawer');
    expect(content).toMatch(/import\s*\{[^}]*\bScrollText\b[^}]*\}\s*from\s*'lucide-react'/);
  });

  it('manages isScriptDrawerOpen state', () => {
    expect(content).toContain('isScriptDrawerOpen');
    expect(content).toContain('setIsScriptDrawerOpen');
  });

  it('renders script library button in toolbar with data-testid="open-scripts-btn"', () => {
    expect(content).toContain('data-testid="open-scripts-btn"');
    expect(content).toContain('setIsScriptDrawerOpen(true)');
    expect(content).toContain('scripts.title');
  });

  it('renders TerminalScriptDrawer component with proper props', () => {
    expect(content).toMatch(/<TerminalScriptDrawer[\s\S]*isOpen=\{isScriptDrawerOpen\}/);
    expect(content).toContain('onExecute=');
    expect(content).toContain('isConnected=');
  });
});
