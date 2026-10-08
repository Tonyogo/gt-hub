import * as fs from 'fs';
import * as path from 'path';

describe('UnifiedTerminalView Mobile Fixed Header & Adaptive Viewport', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('root container does not translate whole window with translate3d', () => {
    // Root container style must not apply translate3d
    expect(content).not.toMatch(/className=\{`[^`]*\bstyle=\{isMobile\s*&&\s*isStandalone\s*\?\s*viewportStyle\s*:\s*undefined\}/);
    expect(content).toContain('workspaceStyle');
  });

  it('top header bar is marked as sticky top-0 and tracked with headerRef', () => {
    expect(content).toContain('headerRef');
    expect(content).toMatch(/sticky\s+top-0\s+z-30/);
  });

  it('workspace container applies dynamic height adaptation without intermediate transition reflow', () => {
    expect(content).toContain("transition: 'none'");
    expect(content).toMatch(/style=\{isMobile\s*&&\s*isStandalone\s*\?\s*workspaceStyle\s*:\s*undefined\}/);
  });

  it('WebTerminalView header has sticky top-0 and does not translate off-screen', () => {
    const webContent = fs.readFileSync(path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx'), 'utf-8');
    expect(webContent).toContain('sticky top-0 z-30');
  });
});
