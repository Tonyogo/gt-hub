import { parseCronExpression, getNextCronTime, isValidCronExpression } from '../src/shared/utils/cronParser';

describe('Cron Parser Utility', () => {
  describe('isValidCronExpression', () => {
    it('validates standard 5-part cron expressions', () => {
      expect(isValidCronExpression('* * * * *')).toBe(true);
      expect(isValidCronExpression('*/5 * * * *')).toBe(true);
      expect(isValidCronExpression('0 2 * * *')).toBe(true);
      expect(isValidCronExpression('0 0 1 1 *')).toBe(true);
      expect(isValidCronExpression('30 4 1,15 * 1-5')).toBe(true);
      expect(isValidCronExpression('0-30/10 1,2 * * 0,7')).toBe(true);
      expect(isValidCronExpression('59 23 31 12 6')).toBe(true);
    });

    it('rejects invalid or malformed cron expressions', () => {
      expect(isValidCronExpression('')).toBe(false);
      expect(isValidCronExpression('invalid')).toBe(false);
      expect(isValidCronExpression('* * * *')).toBe(false); // 4 fields
      expect(isValidCronExpression('* * * * * *')).toBe(false); // 6 fields
      expect(isValidCronExpression('60 * * * *')).toBe(false); // minute out of range
      expect(isValidCronExpression('-1 * * * *')).toBe(false);
      expect(isValidCronExpression('* 24 * * *')).toBe(false); // hour out of range
      expect(isValidCronExpression('* * 0 * *')).toBe(false); // day out of range
      expect(isValidCronExpression('* * 32 * *')).toBe(false);
      expect(isValidCronExpression('* * * 0 *')).toBe(false); // month out of range
      expect(isValidCronExpression('* * * 13 *')).toBe(false);
      expect(isValidCronExpression('* * * * 8')).toBe(false); // day of week out of range
      expect(isValidCronExpression('*/0 * * * *')).toBe(false); // step 0
      expect(isValidCronExpression('*/-5 * * * *')).toBe(false); // negative step
      expect(isValidCronExpression('10-5 * * * *')).toBe(false); // reversed range
      expect(isValidCronExpression('a * * * *')).toBe(false);
    });
  });

  describe('parseCronExpression', () => {
    it('parses valid expression into matching sets or arrays', () => {
      const parsed = parseCronExpression('*/15 2 1-3 * 1');
      expect(parsed).toBeDefined();
      expect(parsed.minutes.has(0)).toBe(true);
      expect(parsed.minutes.has(15)).toBe(true);
      expect(parsed.minutes.has(30)).toBe(true);
      expect(parsed.minutes.has(45)).toBe(true);
      expect(parsed.minutes.has(10)).toBe(false);

      expect(parsed.hours.has(2)).toBe(true);
      expect(parsed.hours.has(3)).toBe(false);

      expect(parsed.daysOfMonth.has(1)).toBe(true);
      expect(parsed.daysOfMonth.has(2)).toBe(true);
      expect(parsed.daysOfMonth.has(3)).toBe(true);
      expect(parsed.daysOfMonth.has(4)).toBe(false);

      expect(parsed.daysOfWeek.has(1)).toBe(true);
      expect(parsed.daysOfWeek.has(2)).toBe(false);
    });

    it('throws error for invalid expression', () => {
      expect(() => parseCronExpression('invalid')).toThrow();
      expect(() => parseCronExpression('60 * * * *')).toThrow();
    });
  });

  describe('getNextCronTime', () => {
    it('calculates the next run timestamp accurately', () => {
      // 2026-10-15 10:00:00 UTC
      const base = new Date('2026-10-15T10:00:00.000Z');

      // Every 5 minutes -> next is 10:05:00
      const next5 = getNextCronTime('*/5 * * * *', base);
      expect(next5.toISOString()).toBe('2026-10-15T10:05:00.000Z');

      // Daily at 02:00 in local time
      const nextDaily = getNextCronTime('0 2 * * *', base);
      expect(nextDaily.getHours()).toBe(2);

      // Daily at 02:00 with explicit UTC
      const nextDailyUtc = getNextCronTime('0 2 * * *', base, 'UTC');
      expect(nextDailyUtc.toISOString()).toBe('2026-10-16T02:00:00.000Z');

      // Even if seconds/ms are non-zero, next run rounds up properly
      const baseWithSec = new Date('2026-10-15T10:02:45.123Z');
      const next5FromSec = getNextCronTime('*/5 * * * *', baseWithSec);
      expect(next5FromSec.toISOString()).toBe('2026-10-15T10:05:00.000Z');
    });

    it('handles month end / year end rollover', () => {
      // Test rollover in local timezone
      const dec31Local = new Date(2026, 11, 31, 23, 55, 0);
      const nextYear = getNextCronTime('0 0 1 1 *', dec31Local);
      expect(nextYear.getFullYear()).toBe(2027);
      expect(nextYear.getMonth()).toBe(0);
      expect(nextYear.getDate()).toBe(1);
      expect(nextYear.getHours()).toBe(0);
      expect(nextYear.getMinutes()).toBe(0);
      expect(nextYear.getSeconds()).toBe(0);

      // Test rollover in explicit UTC timezone
      const dec31Utc = new Date('2026-12-31T23:55:00.000Z');
      const nextYearUtc = getNextCronTime('0 0 1 1 *', dec31Utc, 'UTC');
      expect(nextYearUtc.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    });

    it('correctly handles day of week constraints (0 and 7 both Sunday)', () => {
      // 2026-10-18 is Sunday
      const sat = new Date('2026-10-17T12:00:00.000Z');
      const nextSun0 = getNextCronTime('0 10 * * 0', sat);
      const nextSun7 = getNextCronTime('0 10 * * 7', sat);
      expect(nextSun0.toISOString()).toBe(nextSun7.toISOString());
      expect(nextSun0.getDay()).toBe(0);
    });

    it('throws when given an invalid cron expression', () => {
      expect(() => getNextCronTime('invalid expr')).toThrow();
    });
  });
});
