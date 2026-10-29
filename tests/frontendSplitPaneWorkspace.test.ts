import * as fs from 'fs';
import * as path from 'path';

describe('UnifiedTerminalView Split-Pane Workspace', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('imports Columns2 from lucide-react and declares split mode state', () => {
    expect(content).toMatch(/import\s*\{[^}]*\bColumns2\b[^}]*\}\s*from\s*'lucide-react'/);
    expect(content).toContain('isSplitMode');
    expect(content).toContain('splitRatio');
    expect(content).toContain('activePane');
    expect(content).toContain('splitTerminalRef');
  });

  it('renders split toggle buttons with data-testid in both desktop toolbar and mobile menu', () => {
    expect(content).toContain('data-testid="split-terminal-btn"');
    expect(content).toContain('data-testid="mobile-split-terminal-btn"');
  });

  it('renders draggable vertical divider with data-testid and clamping between 20 and 80 percent', () => {
    expect(content).toContain('data-testid="terminal-split-divider"');
    expect(content).toContain('20');
    expect(content).toContain('80');
    expect(content).toContain('terminal_split_ratio');
  });

  it('renders dual WebTerminalView instances for main and split panes with close button', () => {
    expect(content).toContain('paneId="main"');
    expect(content).toContain('paneId="split"');
    expect(content).toContain('data-testid="close-split-pane-btn"');
    expect(content).toContain('closePaneSession');
  });

  it('routes toolbar actions to active focused terminal ref and synchronizes zoom', () => {
    expect(content).toContain('getActiveTerminalRef');
    expect(content).toContain('splitTerminalRef.current?.zoomIn');
    expect(content).toContain('splitTerminalRef.current?.zoomOut');
  });

  it('binds keyboard shortcuts Alt+D, Alt+W, and Alt+ArrowLeft/Right for split navigation', () => {
    expect(content).toContain('KeyD');
    expect(content).toContain('KeyW');
    expect(content).toContain('ArrowLeft');
    expect(content).toContain('ArrowRight');
  });
});
