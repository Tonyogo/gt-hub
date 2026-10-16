import * as fs from 'fs';
import * as path from 'path';

describe('UnifiedTerminalView SubTab Integration with Tasks & Timezone', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');
  let content: string;

  beforeAll(() => {
    content = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('declares TerminalSubTab union including tasks', () => {
    expect(content).toMatch(/type\s+TerminalSubTab\s*=\s*['"]interactive['"]\s*\|\s*['"]files['"]\s*\|\s*['"]cron['"]\s*\|\s*['"]tasks['"]/);
  });

  it('imports TerminalTaskView and Activity icon', () => {
    expect(content).toContain('TerminalTaskView');
    expect(content).toMatch(/import\s*\{[^}]*Activity[^}]*\}\s*from\s*['"]lucide-react['"]/);
  });

  it('renders tasks SubTab button', () => {
    expect(content).toContain("handleSubTabChange('tasks')");
    expect(content).toMatch(/subTab\s*===\s*['"]tasks['"]/);
  });

  it('renders server timezone badge in header', () => {
    expect(content).toContain('serverTimezone');
  });

  it('renders TerminalTaskView in workspace', () => {
    expect(content).toContain('<TerminalTaskView');
    expect(content).toContain("subTab === 'tasks'");
  });
});
