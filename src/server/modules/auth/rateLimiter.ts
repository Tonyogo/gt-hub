export interface RateLimiterOptions {
  windowMs?: number;
  maxFailures?: number;
  maxEntries?: number;
}

interface FailureRecord {
  count: number;
  resetAt: number;
}

export function parseTrustProxySetting(raw?: string): boolean | number | string {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'false' || trimmed === '0') return false;
  if (trimmed === 'true') return true;
  const num = Number(trimmed);
  if (!Number.isNaN(num) && Number.isInteger(num) && num > 0) {
    return num;
  }
  return trimmed;
}

export function extractClientIp(
  req: { ip?: string; headers?: Record<string, unknown>; socket?: { remoteAddress?: string } },
  trustProxy?: boolean | number | string,
): string {
  const resolvedTrust = trustProxy !== undefined ? trustProxy : parseTrustProxySetting(process.env.TRUST_PROXY);
  const isTrustProxy = Boolean(resolvedTrust && resolvedTrust !== 'false' && resolvedTrust !== '0');
  if (isTrustProxy && req.headers) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim()) {
      const first = xff.split(',')[0].trim();
      if (first) return first;
    } else if (Array.isArray(xff) && xff.length > 0 && typeof xff[0] === 'string') {
      const first = xff[0].split(',')[0].trim();
      if (first) return first;
    }
  }
  if (req.ip) {
    return req.ip;
  }
  return req.socket?.remoteAddress || 'unknown';
}

export class AuthRateLimiter {
  private failures: Map<string, FailureRecord> = new Map();
  private windowMs: number;
  private maxFailures: number;
  private maxEntries: number;

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs || 60 * 1000; // 1 minute window
    this.maxFailures = options.maxFailures || 15; // 15 failed attempts per window
    this.maxEntries = options.maxEntries || 10000;
  }

  public isRateLimited(ip: string): { limited: boolean; retryAfterSec: number } {
    const now = Date.now();
    const record = this.failures.get(ip);
    if (!record) {
      return { limited: false, retryAfterSec: 0 };
    }
    if (now >= record.resetAt) {
      this.failures.delete(ip);
      return { limited: false, retryAfterSec: 0 };
    }
    if (record.count >= this.maxFailures) {
      return {
        limited: true,
        retryAfterSec: Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
      };
    }
    return { limited: false, retryAfterSec: 0 };
  }

  public recordFailure(ip: string): void {
    const now = Date.now();
    if (this.failures.size >= this.maxEntries) {
      for (const [k, v] of this.failures.entries()) {
        if (now >= v.resetAt) this.failures.delete(k);
      }
      if (this.failures.size >= this.maxEntries) {
        const oldestKey = this.failures.keys().next().value;
        if (oldestKey !== undefined) {
          this.failures.delete(oldestKey);
        }
      }
    }
    const existing = this.failures.get(ip);
    if (!existing || now >= existing.resetAt) {
      this.failures.set(ip, { count: 1, resetAt: now + this.windowMs });
    } else {
      existing.count += 1;
    }
  }

  public clear(ip: string): void {
    this.failures.delete(ip);
  }

  public reset(): void {
    this.failures.clear();
  }
}

export const loginRateLimiter = new AuthRateLimiter();
export default loginRateLimiter;
