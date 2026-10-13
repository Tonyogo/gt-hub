import { zh } from '../frontend/src/i18n/locales/zh';
import { en } from '../frontend/src/i18n/locales/en';

describe('i18n scripts keys', () => {
  const requiredKeys = [
    'scripts.title',
    'scripts.searchPlaceholder',
    'scripts.newScript',
    'scripts.runInTerminal',
    'scripts.notConnected',
    'scripts.emptyTitle',
    'scripts.emptyDesc',
    'scripts.deleteConfirm',
    'scripts.saveSuccess',
    'scripts.saveError',
    'scripts.edit',
    'scripts.preview',
    'scripts.namePlaceholder',
  ];

  it('contains all required keys in Chinese and English locales', () => {
    for (const key of requiredKeys) {
      expect((zh as any)[key]).toBeDefined();
      expect((en as any)[key]).toBeDefined();
    }
  });
});
