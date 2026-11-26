import { Request, Response, NextFunction } from 'express';
import zlib from 'zlib';

const MIN_COMPRESS_BYTES = 1024;
// Any UTF-8 string shorter than ceil(1024 / 3) = 342 chars cannot reach 1024 bytes.
const MIN_UTF8_CHAR_CHECK = 342;

/**
 * Asynchronous compression middleware for JSON and text responses >= 1KB.
 * Compresses payload with zlib.gzip (level: Z_BEST_SPEED) on libuv threadpool
 * so large API responses do not block the shared WebSocket event loop.
 */
export function compressionMiddleware(req: Request, res: Response, next: NextFunction): void {
  const acceptEncoding = req.headers['accept-encoding'];
  if (!acceptEncoding || !acceptEncoding.includes('gzip')) {
    return next();
  }

  const originalSend = res.send.bind(res);

  res.send = function (body?: any): Response {
    if (arguments.length > 1) {
      return originalSend.apply(res, arguments as any);
    }

    if (res.headersSent || res.getHeader('Content-Encoding')) {
      return originalSend(body);
    }

    if (req.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304) {
      return originalSend(body);
    }

    let buffer: Buffer | null = null;
    let rawBodyForFallback: any = body;
    let contentType = res.getHeader('Content-Type') as string | undefined;

    if (Buffer.isBuffer(body)) {
      if (body.length < MIN_COMPRESS_BYTES) {
        return originalSend(body);
      }
      buffer = body;
    } else if (typeof body === 'string') {
      if (body.length < MIN_UTF8_CHAR_CHECK) {
        return originalSend(body);
      }
      const byteLen = Buffer.byteLength(body, 'utf8');
      if (byteLen < MIN_COMPRESS_BYTES) {
        return originalSend(body);
      }
      buffer = Buffer.from(body, 'utf8');
    } else if (body !== null && typeof body === 'object') {
      try {
        const jsonStr = JSON.stringify(body);
        if (!contentType) {
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          contentType = 'application/json; charset=utf-8';
        }
        if (jsonStr.length < MIN_UTF8_CHAR_CHECK || Buffer.byteLength(jsonStr, 'utf8') < MIN_COMPRESS_BYTES) {
          return originalSend(jsonStr);
        }
        rawBodyForFallback = jsonStr;
        buffer = Buffer.from(jsonStr, 'utf8');
      } catch {
        return originalSend(body);
      }
    } else {
      return originalSend(body);
    }

    const isCompressible = !contentType || /json|text|javascript|xml|svg|html/i.test(contentType);
    if (!isCompressible) {
      return originalSend(rawBodyForFallback);
    }

    zlib.gzip(buffer, { level: zlib.constants.Z_BEST_SPEED }, (err, gzipped) => {
      if (res.headersSent || res.writableEnded || res.destroyed) {
        return;
      }
      if (!err && gzipped && gzipped.length < buffer!.length) {
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Content-Length', String(gzipped.length));
        originalSend(gzipped);
        return;
      }
      originalSend(rawBodyForFallback);
    });

    return res;
  };

  next();
}

export default compressionMiddleware;
