import { Request } from 'express';

/**
 * Extracts and normalizes hostId or nodeId from an Express request.
 * Priority order:
 * 1. req.params.hostId
 * 2. req.params.nodeId
 * 3. req.query.hostId
 * 4. req.query.nodeId
 * 5. req.body.hostId
 * 6. req.body.nodeId
 */
export function extractHostId(req: Request): string {
  const candidates = [
    req.params?.hostId,
    req.params?.nodeId,
    req.query?.hostId,
    req.query?.nodeId,
    req.body?.hostId,
    req.body?.nodeId,
  ];

  for (const raw of candidates) {
    if (raw === undefined || raw === null) continue;
    const val = Array.isArray(raw) ? raw[0] : raw;
    if (val !== undefined && val !== null) {
      const trimmed = String(val).trim();
      if (trimmed) return trimmed;
    }
  }
  return '';
}
