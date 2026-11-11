import crypto from 'crypto';

/**
 * Performs a constant-time comparison of two secrets to prevent timing attacks.
 * Uses SHA-256 digests to ensure buffers passed to crypto.timingSafeEqual
 * always have identical lengths (32 bytes), regardless of input lengths.
 *
 * If expected is empty or not provided, auth is considered disabled and returns true.
 */
export function safeCompareSecret(provided: unknown, expected: unknown): boolean {
  if (expected === '') {
    return true;
  }

  if (typeof expected !== 'string' || typeof provided !== 'string') {
    return false;
  }

  const hashA = crypto.createHash('sha256').update(provided).digest();
  const hashB = crypto.createHash('sha256').update(expected).digest();

  return crypto.timingSafeEqual(hashA, hashB);
}

export interface RequestLikeForAuth {
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  url?: string;
}

/**
 * Extracts admin secret key from an incoming HTTP or WebSocket request using unified precedence:
 * 1. Headers: 'x-admin-key'
 * 2. Headers: 'Authorization: Bearer <token>'
 * 3. Query params: 'admin_key', then 'x-admin-key', then 'key' (from req.query or parsed req.url)
 */
export function extractAdminKeyFromRequest(req?: RequestLikeForAuth | null): string | undefined {
  if (!req) return undefined;

  // 1. Check headers
  if (req.headers && typeof req.headers === 'object') {
    // 1a. x-admin-key (case-insensitive)
    for (const [key, val] of Object.entries(req.headers)) {
      if (key.toLowerCase() === 'x-admin-key') {
        const raw = Array.isArray(val) ? val[0] : val;
        if (typeof raw === 'string' && raw.trim()) {
          return raw.trim();
        }
      }
    }

    // 1b. Authorization: Bearer <token>
    for (const [key, val] of Object.entries(req.headers)) {
      if (key.toLowerCase() === 'authorization') {
        const raw = Array.isArray(val) ? val[0] : val;
        if (typeof raw === 'string') {
          const match = raw.match(/^Bearer\s+(.+)$/i);
          if (match && match[1]?.trim()) {
            return match[1].trim();
          }
        }
      }
    }
  }

  // 2. Check query parameter from req.query: admin_key -> x-admin-key -> key
  if (req.query && typeof req.query === 'object') {
    const q = req.query as Record<string, unknown>;
    const candidates = [q['admin_key'], q['x-admin-key'], q['key']];
    for (const c of candidates) {
      const raw = Array.isArray(c) ? c[0] : c;
      if (typeof raw === 'string' && raw.trim()) {
        return raw.trim();
      }
    }
  }

  // 3. Check query parameter from req.url
  if (req.url && typeof req.url === 'string' && req.url.includes('?')) {
    try {
      const parsedUrl = new URL(req.url, 'http://localhost');
      const key =
        parsedUrl.searchParams.get('admin_key') ||
        parsedUrl.searchParams.get('x-admin-key') ||
        parsedUrl.searchParams.get('key');
      if (key && key.trim()) {
        return key.trim();
      }
    } catch {
      // Ignore URL parsing errors
    }
  }

  return undefined;
}
