import * as fs from 'fs';
import * as path from 'path';
import { generateScriptExecutionCommand } from '../frontend/src/utils/terminalScriptExecutor';

describe('TerminalScriptDrawer Component Architecture & Logic', () => {
  const componentPath = path.resolve(
    __dirname,
    '../frontend/src/components/terminal/TerminalScriptDrawer.tsx'
  );

  it('verifies TerminalScriptDrawer component file exists and exports TerminalScriptDrawer', () => {
    expect(fs.existsSync(componentPath)).toBe(true);
    const content = fs.readFileSync(componentPath, 'utf-8');
    expect(content).toContain('export const TerminalScriptDrawer');
    expect(content).toContain('export interface TerminalScriptDrawerProps');
  });

  it('includes data-testid="execute-script-btn" and disabled condition when not connected', () => {
    const content = fs.readFileSync(componentPath, 'utf-8');
    expect(content).toContain('data-testid="execute-script-btn"');
    expect(content).toContain('disabled={!isConnected');
    expect(content).toContain('scripts.notConnected');
  });

  it('integrates generateScriptExecutionCommand for safe terminal dispatch', () => {
    const content = fs.readFileSync(componentPath, 'utf-8');
    expect(content).toContain('generateScriptExecutionCommand');
    expect(content).toContain('onExecute(');

    // Verify command generation behavior for drawer
    const sampleScript = 'echo "cleaning"';
    const cmd = generateScriptExecutionCommand(sampleScript, 'bash');
    expect(cmd).toContain('bash -c');
    expect(cmd).toContain('base64 -d');
  });

  it('includes script CRUD operations (list, detail, save, delete) using apiFetch', () => {
    const content = fs.readFileSync(componentPath, 'utf-8');
    expect(content).toContain('apiFetch(');
    expect(content).toContain('/api/admin/scripts');
    expect(content).toContain("method: 'POST'");
    expect(content).toContain("method: 'PUT'");
    expect(content).toContain("method: 'DELETE'");
  });

  it('supports search filtering, editing, and preview toggling', () => {
    const content = fs.readFileSync(componentPath, 'utf-8');
    expect(content).toContain('searchQuery');
    expect(content).toContain('isEditing');
    expect(content).toContain('isCreating');
    expect(content).toContain('scripts.newScript');
    expect(content).toContain('scripts.deleteConfirm');
  });

  it('uses empty metadata tags in new script template and displays script filename in list items', () => {
    const content = fs.readFileSync(componentPath, 'utf-8');
    expect(content).not.toContain('# @title: 新脚本');
    expect(content).toContain('# @title:');
    expect(content).toContain('item.title && item.title !== item.name && item.title !== \'新脚本\'');
  });

  it('avoids duplicate script name in CronJobModal option label when title equals name', () => {
    const cronModalPath = path.resolve(
      __dirname,
      '../frontend/src/components/terminal/components/CronJobModal.tsx'
    );
    const cronContent = fs.readFileSync(cronModalPath, 'utf-8');
    expect(cronContent).toContain('s.title && s.title !== s.name');
  });
});
