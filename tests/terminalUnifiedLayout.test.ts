import * as fs from 'fs';
import * as path from 'path';

describe('UnifiedTerminalView Layout and Header Architecture', () => {
  const unifiedPath = path.resolve(__dirname, '../frontend/src/components/UnifiedTerminalView.tsx');

  let content: string;
  beforeAll(() => {
    content = fs.readFileSync(unifiedPath, 'utf-8');
  });

  it('UnifiedTerminalView should not render redundant macOS action dots', () => {
    expect(content).not.toContain('rounded-full bg-[#EF4444]');
    expect(content).not.toContain('rounded-full bg-[#10B981]');
  });

  it('UnifiedTerminalView should host both WebTerminalView and TerminalFileManagerView without unmounting on subTab toggle', () => {
    expect(content).toMatch(/subTab\s*===\s*'interactive'\s*\?\s*'flex'\s*:\s*'hidden'/);
    expect(content).toMatch(/subTab\s*===\s*'files'\s*\?\s*'flex'\s*:\s*'hidden'/);
  });

  it('UnifiedTerminalView should pass hideHeader={true} to WebTerminalView', () => {
    expect(content).toContain('hideHeader={true}');
  });

  it('UnifiedTerminalView should adaptively show terminal zoom/reset buttons only when subTab is interactive', () => {
    expect(content).toContain("subTab === 'interactive'");
    expect(content).toContain('ZoomIn');
    expect(content).toContain('Trash2');
  });
});
