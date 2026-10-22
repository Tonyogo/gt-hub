import { formatRelativeTime, formatTimezoneOffset } from '../frontend/src/utils/timeHelpers';

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
});
