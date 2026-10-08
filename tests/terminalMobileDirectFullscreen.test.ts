import * as fs from 'fs';
import * as path from 'path';

describe('Terminal Mobile Direct Fullscreen Routing & Logic', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  let unifiedContent: string;

  beforeAll(() => {
    unifiedContent = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('UnifiedTerminalView hides Fullscreen toggle button completely on mobile', () => {
    expect(unifiedContent).toContain('{!isMobile && (');
    expect(unifiedContent).toMatch(/\{!isMobile\s*&&\s*\([\s\S]*?<Maximize2/);
  });
});
