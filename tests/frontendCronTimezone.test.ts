import fs from 'fs';
import path from 'path';
import { zh } from '../frontend/src/i18n/locales/zh';
import { en } from '../frontend/src/i18n/locales/en';

describe('Frontend Cron Timezone Support & i18n', () => {
  it('contains all required timezone i18n translation keys in zh and en', () => {
    // Flat keys
    expect((zh as any)['cron.modal.timezoneLabel']).toBeDefined();
    expect((en as any)['cron.modal.timezoneLabel']).toBeDefined();

    expect((zh as any)['cron.modal.timezoneLocal']).toBeDefined();
    expect((en as any)['cron.modal.timezoneLocal']).toBeDefined();

    expect((zh as any)['cron.modal.timezoneInvalid']).toBeDefined();
    expect((en as any)['cron.modal.timezoneInvalid']).toBeDefined();

    // Nested keys
    expect((zh as any).cron?.modal?.timezoneLabel).toBeDefined();
    expect((en as any).cron?.modal?.timezoneLabel).toBeDefined();
    expect((zh as any).cron?.modal?.timezoneLocal).toBeDefined();
    expect((en as any).cron?.modal?.timezoneLocal).toBeDefined();
    expect((zh as any).cron?.modal?.timezoneInvalid).toBeDefined();
    expect((en as any).cron?.modal?.timezoneInvalid).toBeDefined();
  });

  it('defines timezone field in frontend cron types', () => {
    const typesPath = path.resolve(__dirname, '../frontend/src/components/terminal/types/cron.ts');
    const content = fs.readFileSync(typesPath, 'utf-8');
    expect(content).toMatch(/timezone\?: string;/);
  });

  it('binds timezone selection and validation in CronJobModal.tsx', () => {
    const modalPath = path.resolve(__dirname, '../frontend/src/components/terminal/components/CronJobModal.tsx');
    const content = fs.readFileSync(modalPath, 'utf-8');
    expect(content).toMatch(/timezone/);
    expect(content).toMatch(/Asia\/Shanghai/);
    expect(content).toMatch(/America\/New_York/);
    expect(content).toMatch(/timezoneInvalid/);
  });

  it('renders timezone badge in TerminalCronView.tsx', () => {
    const viewPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalCronView.tsx');
    const content = fs.readFileSync(viewPath, 'utf-8');
    expect(content).toMatch(/job\.timezone/);
  });
});
