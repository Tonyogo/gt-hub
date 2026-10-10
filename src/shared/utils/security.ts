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
