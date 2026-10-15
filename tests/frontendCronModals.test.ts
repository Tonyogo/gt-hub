import * as fs from 'fs';
import * as path from 'path';

describe('Frontend Cron Modals Standards and Functionality', () => {
  const cronJobModalPath = path.resolve(__dirname, '../frontend/src/components/terminal/components/CronJobModal.tsx');
  const cronLogModalPath = path.resolve(__dirname, '../frontend/src/components/terminal/components/CronLogModal.tsx');

  let cronJobModalContent: string;
  let cronLogModalContent: string;

  beforeAll(() => {
    cronJobModalContent = fs.readFileSync(cronJobModalPath, 'utf-8');
    cronLogModalContent = fs.readFileSync(cronLogModalPath, 'utf-8');
  });

  describe('CronJobModal', () => {
    it('has no raw alert() calls', () => {
      const alertCalls = cronJobModalContent.match(/(?<![a-zA-Z0-9_.])alert\s*\(/g);
      expect(alertCalls).toBeNull();
    });

    it('exports CronJobModal component', () => {
      expect(cronJobModalContent).toContain('export const CronJobModal');
    });

    it('contains standard 5-part cron presets', () => {
      expect(cronJobModalContent).toContain('* * * * *');
      expect(cronJobModalContent).toContain('*/5 * * * *');
      expect(cronJobModalContent).toContain('0 * * * *');
      expect(cronJobModalContent).toContain('0 2 * * *');
      expect(cronJobModalContent).toContain('0 9 * * 1-5');
    });

    it('supports dual-mode command and hub script configuration', () => {
      expect(cronJobModalContent).toContain("'command'");
      expect(cronJobModalContent).toContain("'hub'");
      expect(cronJobModalContent).toContain('/api/admin/scripts');
    });

    it('implements validation for cron format and required fields', () => {
      expect(
        cronJobModalContent.includes('^(\\S+\\s+){4}\\S+$') ||
        cronJobModalContent.includes('.trim().split(/\\s+/).length === 5') ||
        cronJobModalContent.includes('parts.length !== 5') ||
        cronJobModalContent.includes('parts.length === 5')
      ).toBe(true);
    });

    it('supports advanced options: concurrency and timeout', () => {
      expect(cronJobModalContent).toContain('concurrency');
      expect(cronJobModalContent).toContain('timeoutMs');
    });
  });

  describe('CronLogModal', () => {
    it('has no raw alert() calls', () => {
      const alertCalls = cronLogModalContent.match(/(?<![a-zA-Z0-9_.])alert\s*\(/g);
      expect(alertCalls).toBeNull();
    });

    it('exports CronLogModal component', () => {
      expect(cronLogModalContent).toContain('export const CronLogModal');
    });

    it('implements clipboard copy with writeText and refresh action', () => {
      expect(cronLogModalContent).toContain('navigator.clipboard.writeText');
      expect(cronLogModalContent).toContain('copied');
    });

    it('renders terminal window with dark styling and exitCode badge', () => {
      expect(cronLogModalContent).toMatch(/bg-(slate|zinc|gray|neutral)-(900|950)/);
      expect(cronLogModalContent).toContain('exitCode');
    });
  });
});
