import { zh } from '../frontend/src/i18n/locales/zh';
import { en } from '../frontend/src/i18n/locales/en';

describe('Frontend Cron i18n Dictionary', () => {
  const requiredKeys = [
    'cron.title',
    'cron.tabName',
    'cron.addJob',
    'cron.editJob',
    'cron.deleteJob',
    'cron.deleteConfirm',
    'cron.runNow',
    'cron.runSuccess',
    'cron.pause',
    'cron.resume',
    'cron.logs',
    'cron.nextRun',
    'cron.lastStatus',
    'cron.duration',
    'cron.emptyTitle',
    'cron.emptyDesc',
    'cron.sourceCommand',
    'cron.sourceScript',
    'cron.modal.nameLabel',
    'cron.modal.cronLabel',
    'cron.modal.presetLabel',
    'cron.modal.concurrencyLabel',
    'cron.modal.timeoutLabel',
  ];

  it('contains all required cron keys in both zh and en dictionaries', () => {
    for (const key of requiredKeys) {
      expect((zh as any)[key]).toBeDefined();
      expect((en as any)[key]).toBeDefined();
    }
  });
});
