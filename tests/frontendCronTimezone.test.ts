import fs from 'fs';
import path from 'path';

describe('Frontend Cron Server-Authoritative Timezone UI Transparency', () => {
  it('defines timezone field in frontend cron types for API responses', () => {
    const typesPath = path.resolve(__dirname, '../frontend/src/components/terminal/types/cron.ts');
    const content = fs.readFileSync(typesPath, 'utf-8');
    expect(content).toMatch(/timezone\?: string;/);
  });

  it('removes timezone selection dropdown and validation from CronJobModal.tsx', () => {
    const modalPath = path.resolve(__dirname, '../frontend/src/components/terminal/components/CronJobModal.tsx');
    const content = fs.readFileSync(modalPath, 'utf-8');
    expect(content).not.toMatch(/timezoneInvalid/);
    expect(content).not.toMatch(/timezoneMode/);
    expect(content).not.toMatch(/<select[^>]*timezone/);
    expect(content).not.toMatch(/nodeTimezone/);
  });

  it('removes header timezone badge and nodeTimezone state from TerminalCronView.tsx', () => {
    const viewPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalCronView.tsx');
    const content = fs.readFileSync(viewPath, 'utf-8');
    expect(content).not.toMatch(/cron\.timezoneBadge/);
    expect(content).not.toMatch(/nodeTimezone/);
  });

  it('removes timezone from host info row in TerminalHostSelector.tsx', () => {
    const selectorPath = path.resolve(__dirname, '../frontend/src/components/terminal/TerminalHostSelector.tsx');
    const content = fs.readFileSync(selectorPath, 'utf-8');
    expect(content).not.toMatch(/h\.timezone/);
  });
});
