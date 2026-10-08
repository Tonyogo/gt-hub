import * as fs from 'fs';
import * as path from 'path';

describe('Terminal Component Handles and Props Verification', () => {
  const webTerminalPath = path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx');
  const fileManagerPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalFileManagerView.tsx');

  it('WebTerminalView exports WebTerminalHandle and supports hideHeader and handle callbacks', () => {
    const content = fs.readFileSync(webTerminalPath, 'utf-8');
    expect(content).toContain('export interface WebTerminalHandle');
    expect(content).toContain('hideHeader');
    expect(content).toContain('onConnectionChange');
    expect(content).toContain('onSelectModeChange');
  });

  it('TerminalFileManagerView exports TerminalFileManagerHandle', () => {
    const content = fs.readFileSync(fileManagerPath, 'utf-8');
    expect(content).toContain('export interface TerminalFileManagerHandle');
  });
});
