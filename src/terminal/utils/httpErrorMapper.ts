/**
 * Maps RPC or internal error messages to semantic HTTP status codes.
 *
 * Matching priority (case-insensitive):
 * 1. 400 Bad Request: /invalid|required|cannot be empty|not a directory|is a directory|already exists|malformed|boundary not found|no files uploaded/i
 * 2. 403 Forbidden: /permission denied|eacces|eperm|access denied|outside.*workspace|path traversal|sandbox|forbidden/i
 * 3. 404 Not Found: /not found|no such file|no such task|enoent|does not exist/i
 * 4. 503 Service Unavailable: /offline|unavailable|not connected|disconnected|reconnected.*cancelled/i
 * 5. 504 Gateway Timeout: /timed?\s*out/i
 * 6. Fallback: fallbackStatus (default 500)
 */
export function mapRpcErrorToHttpStatus(
  errorMsg?: string | null,
  fallbackStatus: number = 500
): number {
  if (!errorMsg || typeof errorMsg !== 'string') {
    return fallbackStatus;
  }

  const msg = errorMsg.trim();
  if (!msg) {
    return fallbackStatus;
  }

  // 1. 400 Bad Request
  if (/invalid|required|cannot be empty|not a directory|is a directory|already exists|malformed|boundary not found|no files uploaded/i.test(msg)) {
    return 400;
  }

  // 2. 403 Forbidden
  if (/permission denied|eacces|eperm|access denied|outside.*workspace|path traversal|sandbox|forbidden/i.test(msg)) {
    return 403;
  }

  // 3. 404 Not Found
  if (/not found|no such file|no such task|enoent|does not exist/i.test(msg)) {
    return 404;
  }

  // 4. 503 Service Unavailable
  if (/offline|unavailable|not connected|disconnected|reconnected.*cancelled/i.test(msg)) {
    return 503;
  }

  // 5. 504 Gateway Timeout
  if (/timed?\s*out/i.test(msg)) {
    return 504;
  }

  return fallbackStatus;
}
