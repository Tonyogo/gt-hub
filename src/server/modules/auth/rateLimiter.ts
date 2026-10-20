export interface RateLimiterOptions {
  windowMs?: number;
  maxFailures?: number;
}

interface FailureRecord {
  count: number;
  resetAt: number;
}

export class AuthRateLimiter {
  private failures: Map<string, FailureRecord> = new Map();
  private windowMs: number;
  private maxFailures: number;

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs || 60 * 1000; // 1 minute window
    this.maxFailures = options.maxFailures || 15; // 15 failed attempts per window
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
    if (this.failures.size > 5000) {
      for (const [k, v] of this.failures.entries()) {
        if (now >= v.resetAt) this.failures.delete(k);
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
