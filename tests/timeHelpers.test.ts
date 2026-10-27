import { formatRelativeTime, formatTimezoneOffset, formatUptime } from '../frontend/src/utils/timeHelpers';

describe('Time Helpers Unit Tests', () => {
  describe('formatRelativeTime', () => {
    it('returns empty string for invalid timestamp', () => {
      expect(formatRelativeTime(0)).toBe('');
      expect(formatRelativeTime(NaN)).toBe('');
    });

    it('formats recent offline relative time in zh and en', () => {
      const now = Date.now();
      expect(formatRelativeTime(now - 10000, 'zh', now)).toBe('刚刚离线');
      expect(formatRelativeTime(now - 10000, 'en', now)).toBe('Just now');
      expect(formatRelativeTime(now - 120000, 'zh', now)).toBe('离线于 2分钟前');
      expect(formatRelativeTime(now - 120000, 'en', now)).toBe('Offline 2m ago');
    });
  });

  describe('formatTimezoneOffset', () => {
    it('returns empty string for empty or missing input', () => {
      expect(formatTimezoneOffset('')).toBe('');
      expect(formatTimezoneOffset(null as any)).toBe('');
      expect(formatTimezoneOffset(undefined as any)).toBe('');
    });

    it('formats UTC and GMT cleanly as UTC+0', () => {
      expect(formatTimezoneOffset('UTC')).toBe('UTC+0');
      expect(formatTimezoneOffset('GMT')).toBe('UTC+0');
    });

    it('formats Asia/Shanghai as UTC+8', () => {
      expect(formatTimezoneOffset('Asia/Shanghai')).toBe('UTC+8');
    });

    it('formats Asia/Tokyo as UTC+9', () => {
      expect(formatTimezoneOffset('Asia/Tokyo')).toBe('UTC+9');
    });

    it('formats Europe/London with valid UTC offset', () => {
      const offset = formatTimezoneOffset('Europe/London');
      expect(offset).toMatch(/^UTC[+-]\d+$/);
    });

    it('falls back to raw string for invalid timezone identifiers', () => {
      expect(formatTimezoneOffset('Invalid/Unknown_Zone')).toBe('Invalid/Unknown_Zone');
    });
  });

  describe('formatUptime', () => {
    it('returns empty string for invalid or non-positive timestamps', () => {
      expect(formatUptime(0)).toBe('');
      expect(formatUptime(NaN)).toBe('');
      expect(formatUptime(-500)).toBe('');
    });

    it('clamps future timestamps (clock skew) to < 1m', () => {
      const now = 1700000000000;
      expect(formatUptime(now + 30000, 'zh', now)).toBe('< 1m');
      expect(formatUptime(now + 30000, 'en', now)).toBe('< 1m');
    });

    it('formats sub-minute, minute, hour, and multi-day durations accurately', () => {
      const now = 1700000000000;
      // 45 seconds -> < 1m
      expect(formatUptime(now - 45 * 1000, 'zh', now)).toBe('< 1m');
      // 25 minutes -> 25m
      expect(formatUptime(now - 25 * 60 * 1000, 'zh', now)).toBe('25m');
      // Exact 2 hours -> 2h
      expect(formatUptime(now - 2 * 3600 * 1000, 'zh', now)).toBe('2h');
      // 5 hours 20 minutes -> 5h 20m
      expect(formatUptime(now - (5 * 3600 + 20 * 60) * 1000, 'en', now)).toBe('5h 20m');
      // Exact 3 days -> 3d
      expect(formatUptime(now - 3 * 86400 * 1000, 'zh', now)).toBe('3d');
      // 3 days 12 hours -> 3d 12h
      expect(formatUptime(now - (3 * 86400 + 12 * 3600) * 1000, 'en', now)).toBe('3d 12h');
    });
  });
});
