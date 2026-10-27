import { Request, Response, NextFunction } from 'express';
import zlib from 'zlib';

/**
 * Compression middleware for JSON and text responses >= 1KB.
 * Compresses payload with zlib.gzipSync when client accepts gzip.
 */
export function compressionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const acceptEncoding = req.headers['accept-encoding'];
  if (!acceptEncoding || !acceptEncoding.includes('gzip')) {
    return next();
  }

  const originalSend = res.send.bind(res);

  res.send = function (body?: any): Response {
    if (res.headersSent || res.getHeader('Content-Encoding')) {
      return originalSend(body);
    }

    if (req.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304) {
      return originalSend(body);
    }

    let buffer: Buffer | null = null;
    let contentType = res.getHeader('Content-Type') as string | undefined;

    if (Buffer.isBuffer(body)) {
      buffer = body;
    } else if (typeof body === 'string') {
      buffer = Buffer.from(body);
    } else if (body !== null && typeof body === 'object') {
      try {
        const jsonStr = JSON.stringify(body);
        buffer = Buffer.from(jsonStr);
        if (!contentType) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          contentType = 'application/json; charset=utf-8';
        }
      } catch {
        return originalSend(body);
      }
    }

    if (!buffer || buffer.length < 1024) {
      return originalSend(body);
    }

    const isCompressible = !contentType || /json|text|javascript|xml|svg|html/i.test(contentType);
    if (!isCompressible) {
      return originalSend(body);
    }

    try {
      const gzipped = zlib.gzipSync(buffer, { level: zlib.constants.Z_BEST_SPEED });
      if (gzipped.length < buffer.length) {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Content-Length', String(gzipped.length));
        return originalSend(gzipped);
      }
    } catch {
      // Fallback on compression failure
    }

    return originalSend(body);
  };

  next();
}

export default compressionMiddleware;
