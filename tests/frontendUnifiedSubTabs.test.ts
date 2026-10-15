import * as fs from 'fs';
import * as path from 'path';

describe('UnifiedTerminalView SubTab Integration with Cron', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  let unifiedContent: string;

  beforeAll(() => {
    unifiedContent = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('declares TerminalSubTab union including cron', () => {
    expect(unifiedContent).toMatch(/type\s+TerminalSubTab\s*=\s*['"]interactive['"]\s*\|\s*['"]files['"]\s*\|\s*['"]cron['"]/);
  });

  it('imports TerminalCronView and Clock icon', () => {
    expect(unifiedContent).toContain('TerminalCronView');
    expect(unifiedContent).toMatch(/import\s*\{[^}]*Clock[^}]*\}\s*from\s*['"]lucide-react['"]/);
  });

  it('renders cron SubTab pill button with Clock icon', () => {
    expect(unifiedContent).toContain("handleSubTabChange('cron')");
    expect(unifiedContent).toMatch(/subTab\s*===\s*['"]cron['"]/);
  });

  it('renders TerminalCronView workspace panel conditionally or toggleable', () => {
    expect(unifiedContent).toContain('<TerminalCronView');
    expect(unifiedContent).toContain('activeHostId={activeHostId}');
  });
});
