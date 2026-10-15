import { isValidTimezone, getNextCronTime } from '../src/shared/utils/cronParser';

describe('Cron Parser Timezone Support', () => {
  it('validates IANA timezones accurately', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Asia/Shanghai')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('local')).toBe(true);
    expect(isValidTimezone(undefined)).toBe(true);
    expect(isValidTimezone('')).toBe(true);
    expect(isValidTimezone('Invalid/Timezone')).toBe(false);
    expect(isValidTimezone('foobar')).toBe(false);
  });

  it('calculates next run using local time when timezone is omitted', () => {
    const base = new Date('2026-10-15T10:00:00.000Z');
    const next = getNextCronTime('0 2 * * *', base);
    expect(next.getHours()).toBe(2);
  });

  it('calculates next run using UTC when timezone is UTC', () => {
    const base = new Date('2026-10-15T10:00:00.000Z');
    const next = getNextCronTime('0 2 * * *', base, 'UTC');
    expect(next.getUTCHours()).toBe(2);
  });

  it('calculates next run for specific timezone like Asia/Shanghai', () => {
    // 2026-10-15 00:30:00 UTC = 2026-10-15 08:30:00 Beijing time (UTC+8)
    const base = new Date('2026-10-15T00:30:00.000Z');
    // 0 9 * * * in Asia/Shanghai should be 2026-10-15 09:00:00 Beijing time = 2026-10-15 01:00:00 UTC
    const next = getNextCronTime('0 9 * * *', base, 'Asia/Shanghai');
    expect(next.toISOString()).toBe('2026-10-15T01:00:00.000Z');
  });

  it('verifies timezone offset difference between Asia/Shanghai and UTC', () => {
    const base = new Date('2026-10-15T00:00:00.000Z');
    const nextUtc = getNextCronTime('0 12 * * *', base, 'UTC');
    const nextSha = getNextCronTime('0 12 * * *', base, 'Asia/Shanghai');
    // Asia/Shanghai is UTC+8, so 12:00 in Shanghai happens 8 hours earlier than 12:00 UTC on the same day
    const diffHours = (nextUtc.getTime() - nextSha.getTime()) / (1000 * 60 * 60);
    expect(diffHours).toBe(8);
  });

  it('throws for invalid timezone in getNextCronTime', () => {
    expect(() => getNextCronTime('0 2 * * *', new Date(), 'Invalid/Zone')).toThrow('Invalid timezone');
  });
});

describe('resolveServerTimezone Priority & Fallback', () => {
  const origTimeZone = process.env.TIME_ZONE;
  const origTz = process.env.TZ;

  afterEach(() => {
    if (origTimeZone === undefined) delete process.env.TIME_ZONE;
    else process.env.TIME_ZONE = origTimeZone;

    if (origTz === undefined) delete process.env.TZ;
    else process.env.TZ = origTz;
  });

  it('respects TIME_ZONE as highest priority when valid', () => {
    const { resolveServerTimezone } = require('../config/default');
    process.env.TIME_ZONE = 'America/Chicago';
    process.env.TZ = 'Europe/London';
    expect(resolveServerTimezone()).toBe('America/Chicago');
  });

  it('falls back to TZ when TIME_ZONE is invalid', () => {
    const { resolveServerTimezone } = require('../config/default');
    process.env.TIME_ZONE = 'Invalid/Zone';
    process.env.TZ = 'Europe/Paris';
    expect(resolveServerTimezone()).toBe('Europe/Paris');
  });

  it('falls back to fallback when both TIME_ZONE and TZ are invalid', () => {
    const { resolveServerTimezone } = require('../config/default');
    process.env.TIME_ZONE = 'Invalid/Zone1';
    process.env.TZ = 'Invalid/Zone2';
    const resolved = resolveServerTimezone();
    expect(isValidTimezone(resolved)).toBe(true);
    expect(['Asia/Shanghai', Intl.DateTimeFormat().resolvedOptions().timeZone]).toContain(resolved);
  });
});
