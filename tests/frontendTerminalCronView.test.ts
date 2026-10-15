import * as fs from 'fs';
import * as path from 'path';

describe('Frontend TerminalCronView Component Standards and Capabilities', () => {
  const cronViewPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalCronView.tsx');
  let cronViewContent: string;

  beforeAll(() => {
    cronViewContent = fs.readFileSync(cronViewPath, 'utf-8');
  });

  it('has no raw alert() calls', () => {
    const alertCalls = cronViewContent.match(/(?<![a-zA-Z0-9_.])alert\s*\(/g);
    expect(alertCalls).toBeNull();
  });

  it('exports TerminalCronView component and handle interface', () => {
    expect(cronViewContent).toContain('export const TerminalCronView');
    expect(cronViewContent).toContain('TerminalCronHandle');
  });

  it('uses apiFetch for all cron backend communication', () => {
    expect(cronViewContent).toContain('apiFetch');
    expect(cronViewContent).toContain('/api/terminal/cron/');
  });

  it('orchestrates cron operations: run now, toggle status, delete, edit, and logs', () => {
    expect(cronViewContent).toContain('/run');
    expect(cronViewContent).toContain("'PATCH'");
    expect(cronViewContent).toContain("'DELETE'");
    expect(cronViewContent).toContain('CronLogModal');
    expect(cronViewContent).toContain('CronJobModal');
  });

  it('implements toast feedback mechanism and handles offline/empty states', () => {
    expect(cronViewContent).toContain('Toast');
    expect(cronViewContent).toContain('showToast');
    expect(cronViewContent).toMatch(/(emptyTitle|emptyDesc|noOnlineHosts|noNode)/);
  });
});
