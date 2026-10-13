import * as fs from 'fs';
import * as path from 'path';

describe('Terminal Mobile Direct Fullscreen Routing & Logic', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  let unifiedContent: string;

  beforeAll(() => {
    unifiedContent = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('UnifiedTerminalView renders Fullscreen toggle button universally on both mobile and desktop', () => {
    expect(unifiedContent).not.toMatch(/\{!isMobile\s*&&\s*\([\s\S]*?<button[^>]*data-testid="fullscreen-toggle-btn"/);
    expect(unifiedContent).toContain('data-testid="fullscreen-toggle-btn"');
    expect(unifiedContent).toContain('handleFullscreenToggle');
  });
});
