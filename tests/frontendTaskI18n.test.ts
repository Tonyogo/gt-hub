import { zh } from '../frontend/src/i18n/locales/zh';
import { en } from '../frontend/src/i18n/locales/en';

describe('Frontend Task Management i18n Dictionary', () => {
  const requiredKeys = [
    'tasks.tabName',
    'tasks.title',
    'tasks.createTask',
    'tasks.refresh',
    'tasks.searchPlaceholder',
    'tasks.filterAll',
    'tasks.filterRunning',
    'tasks.filterCompleted',
    'tasks.filterFailed',
    'tasks.filterKilled',
    'tasks.statTotal',
    'tasks.statRunning',
    'tasks.statCompleted',
    'tasks.statFailed',
    'tasks.colTaskId',
    'tasks.colCommand',
    'tasks.colStatus',
    'tasks.colExitCode',
    'tasks.colDuration',
    'tasks.colStartTime',
    'tasks.colActions',
    'tasks.viewLogs',
    'tasks.killTask',
    'tasks.killConfirm',
    'tasks.copySuccess',
    'tasks.emptyTitle',
    'tasks.emptyDesc',
    'tasks.noNode',
    'tasks.nodeOffline',
    'tasks.createModal.title',
    'tasks.createModal.commandLabel',
    'tasks.createModal.cwdLabel',
    'tasks.createModal.timeoutLabel',
    'tasks.createModal.submit',
    'tasks.createModal.cancel',
    'tasks.logsModal.title',
    'tasks.logsModal.autoScroll',
    'tasks.logsModal.copy',
    'tasks.logsModal.close',
    'common.serverTimezone',
  ];

  it('contains all required task keys in both zh and en dictionaries', () => {
    for (const key of requiredKeys) {
      expect((zh as any)[key]).toBeDefined();
      expect((en as any)[key]).toBeDefined();
    }
  });
});
