import { ByteRange, RangeParseResult } from '../types/file';

export { ByteRange, RangeParseResult };

/**
 * Parses HTTP Range header according to RFC 7233 / RFC 9110.
 * Supports:
 * - bytes=start-end (closed range)
 * - bytes=start- (open-ended range)
 * - bytes=-suffix (suffix range)
 *
 * Returns null if Range header is missing or malformed (caller should fallback to 200 OK full stream).
 * Returns { status: 'unsatisfiable', totalSize } if range is out of bounds (caller should return 416).
 */
export function parseRangeHeader(
  rangeHeader: string | undefined | null,
  totalSize: number
): RangeParseResult {
  if (!rangeHeader || typeof rangeHeader !== 'string') {
    return null;
  }

  const trimmed = rangeHeader.trim();
  if (!trimmed.startsWith('bytes=')) {
    return null;
  }

  if (totalSize <= 0) {
    return { status: 'unsatisfiable', totalSize: Math.max(0, totalSize) };
  }

  const rangeSpec = trimmed.slice(6).trim();
  // Only support single range specification
  if (rangeSpec.includes(',')) {
    return null;
  }

  const dashIndex = rangeSpec.indexOf('-');
  if (dashIndex === -1) {
    return null;
  }

  const startStr = rangeSpec.slice(0, dashIndex).trim();
  const endStr = rangeSpec.slice(dashIndex + 1).trim();

  // Suffix range: bytes=-500 (last 500 bytes)
  if (startStr === '') {
    if (endStr === '') return null;
    const suffixLength = parseInt(endStr, 10);
    if (isNaN(suffixLength) || suffixLength <= 0) return null;

    const start = Math.max(0, totalSize - suffixLength);
    const end = totalSize - 1;
    return {
      status: 'valid',
      range: {
        start,
        end,
        length: end - start + 1,
        totalSize,
      },
    };
  }

  const start = parseInt(startStr, 10);
  if (isNaN(start) || start < 0) {
    return null;
  }

  if (start >= totalSize) {
    return { status: 'unsatisfiable', totalSize };
  }

  // Open-ended range: bytes=500- (from 500 to end of file)
  if (endStr === '') {
    const end = totalSize - 1;
    return {
      status: 'valid',
      range: {
        start,
        end,
        length: end - start + 1,
        totalSize,
      },
    };
  }

  // Closed range: bytes=0-499
  const end = parseInt(endStr, 10);
  if (isNaN(end)) {
    return null;
  }

  if (start > end) {
    return { status: 'unsatisfiable', totalSize };
  }

  const clampedEnd = Math.min(end, totalSize - 1);
  return {
    status: 'valid',
    range: {
      start,
      end: clampedEnd,
      length: clampedEnd - start + 1,
      totalSize,
    },
  };
}

export function applyRangeHeaders(
  res: any,
  range: ByteRange,
  filename: string
): void {
  res.status(206);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${range.totalSize}`);
  res.setHeader('Content-Length', range.length);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
}

export function applyUnsatisfiableHeaders(res: any, totalSize: number): void {
  res.status(416);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Range', `bytes */${totalSize}`);
}
