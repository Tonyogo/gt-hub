import express, { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import { promisify } from 'util';
import config from '../../config/default';

const gzipAsync = promisify(zlib.gzip);
const brotliAsync = promisify(zlib.brotliCompress);

const COMPRESSIBLE_EXTS = new Set([
  '.js',
  '.mjs',
  '.css',
  '.html',
  '.htm',
  '.svg',
  '.json',
  '.txt',
  '.map',
  '.xml',
]);

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

const MIN_COMPRESS_BYTES = 1024;
const MAX_CACHED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 64;

interface CompressedCacheEntry {
  mtimeMs: number;
  size: number;
  br?: Buffer;
  gzip?: Buffer;
}

function resolveDefaultFrontendDist(): string | null {
  const candidates = [
    path.join(__dirname, '../../../../dist/frontend'),
    path.join(__dirname, '../../../dist/frontend'),
    path.join(__dirname, '../../dist/frontend'),
    path.join(process.cwd(), 'dist/frontend'),
    path.join(process.cwd(), 'frontend'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function getCacheControlForAsset(relPath: string, filePath: string, forceNoCache: boolean = false): string {
  if (forceNoCache || path.basename(filePath) === 'index.html') {
    return 'no-cache';
  }
  const normalizedRel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (normalizedRel.startsWith('assets/')) {
    return 'public, max-age=31536000, immutable';
  }
  return 'public, max-age=3600';
}

function pickAcceptedEncoding(req: Request): 'br' | 'gzip' | null {
  const raw = req.headers['accept-encoding'];
  const header = Array.isArray(raw) ? raw.join(',') : raw;
  if (!header) return null;
  if (/\bbr\b/i.test(header) && typeof zlib.brotliCompress === 'function') {
    return 'br';
  }
  if (/\bgzip\b/i.test(header)) {
    return 'gzip';
  }
  return null;
}

function buildEtag(stat: fs.Stats, encoding: 'br' | 'gzip'): string {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}-${encoding}"`;
}

function matchesIfNoneMatch(headerVal: string | string[] | undefined, etag: string): boolean {
  if (!headerVal) return false;
  const raw = Array.isArray(headerVal) ? headerVal.join(',') : headerVal;
  if (raw.trim() === '*') return true;
  return raw
    .split(',')
    .map((part) => part.trim())
    .some((part) => part === etag);
}

export function createStaticMiddleware(customDistDir?: string): Router {
  let cachedFrontendDist: string | null = customDistDir ? path.resolve(customDistDir) : null;
  let cachedStaticHandler: RequestHandler | null = null;
  const compressedCache = new Map<string, CompressedCacheEntry>();

  const getDistAndStaticHandler = (): { distDir: string | null; staticHandler: RequestHandler | null } => {
    if (customDistDir) {
      if (!cachedFrontendDist || !fs.existsSync(cachedFrontendDist)) {
        return { distDir: null, staticHandler: null };
      }
      if (!cachedStaticHandler) {
        const rootDir = cachedFrontendDist;
        cachedStaticHandler = express.static(rootDir, {
          index: false,
          setHeaders: (res, filePath) => {
            const rel = path.relative(rootDir, filePath);
            res.setHeader('Cache-Control', getCacheControlForAsset(rel, filePath));
          },
        });
      }
      return { distDir: cachedFrontendDist, staticHandler: cachedStaticHandler };
    }

    if (cachedFrontendDist && fs.existsSync(cachedFrontendDist) && cachedStaticHandler) {
      return { distDir: cachedFrontendDist, staticHandler: cachedStaticHandler };
    }

    const found = resolveDefaultFrontendDist();
    if (found !== cachedFrontendDist) {
      cachedFrontendDist = found;
      compressedCache.clear();
      cachedStaticHandler = found
        ? express.static(found, {
            index: false,
            setHeaders: (res, filePath) => {
              const rel = path.relative(found, filePath);
              res.setHeader('Cache-Control', getCacheControlForAsset(rel, filePath));
            },
          })
        : null;
    }
    return { distDir: cachedFrontendDist, staticHandler: cachedStaticHandler };
  };

  const getCachedOrCompress = async (
    filePath: string,
    stat: fs.Stats,
    encoding: 'br' | 'gzip'
  ): Promise<Buffer | null> => {
    let entry = compressedCache.get(filePath);
    if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
      entry = { mtimeMs: stat.mtimeMs, size: stat.size };
    } else {
      const existing = entry[encoding];
      if (existing !== undefined) {
        // Refresh insertion order (LRU)
        compressedCache.delete(filePath);
        compressedCache.set(filePath, entry);
        return existing;
      }
    }

    const raw = await fs.promises.readFile(filePath);
    const compressed =
      encoding === 'br'
        ? await brotliAsync(raw, {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
            },
          })
        : await gzipAsync(raw, { level: zlib.constants.Z_BEST_SPEED });

    if (compressed.length >= raw.length) {
      return null;
    }

    entry[encoding] = compressed;
    if (compressedCache.has(filePath)) {
      compressedCache.delete(filePath);
    } else if (compressedCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = compressedCache.keys().next().value;
      if (oldestKey !== undefined) {
        compressedCache.delete(oldestKey);
      }
    }
    compressedCache.set(filePath, entry);
    return compressed;
  };

  const tryServeCompressed = async (
    req: Request,
    res: Response,
    filePath: string,
    stat: fs.Stats,
    cacheControl: string
  ): Promise<boolean> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return false;
    }
    if (req.headers.range) {
      return false;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (!COMPRESSIBLE_EXTS.has(ext) || stat.size < MIN_COMPRESS_BYTES) {
      return false;
    }

    const encoding = pickAcceptedEncoding(req);
    if (!encoding) {
      return false;
    }

    const etag = buildEtag(stat, encoding);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    if (stat.size > MAX_CACHED_FILE_BYTES) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Cache-Control', cacheControl);
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('ETag', etag);

      if (matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
        res.status(304).end();
        return true;
      }

      res.setHeader('Content-Encoding', encoding);
      if (req.method === 'HEAD') {
        res.status(200).end();
        return true;
      }

      await new Promise<void>((resolve, reject) => {
        const readStream = fs.createReadStream(filePath);
        const compressor =
          encoding === 'br'
            ? zlib.createBrotliCompress({
                params: {
                  [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
                },
              })
            : zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED });

        let settled = false;
        const finish = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (err) {
            readStream.destroy();
            compressor.destroy();
            reject(err);
          } else {
            resolve();
          }
        };

        readStream.on('error', finish);
        compressor.on('error', finish);
        res.on('error', finish);
        res.on('finish', () => finish());
        res.on('close', () => {
          if (!res.writableEnded) {
            readStream.destroy();
            compressor.destroy();
          }
          finish();
        });

        readStream.pipe(compressor).pipe(res);
      });
      return true;
    }

    const compressed = await getCachedOrCompress(filePath, stat, encoding);
    if (!compressed) {
      return false;
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('ETag', etag);

    if (matchesIfNoneMatch(req.headers['if-none-match'], etag)) {
      res.status(304).end();
      return true;
    }

    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Length', String(compressed.length));
    if (req.method === 'HEAD') {
      res.status(200).end();
      return true;
    }

    res.status(200).end(compressed);
    return true;
  };

  const router = Router();

  if (config.enableUi || customDistDir) {
    router.use(async (req: Request, res: Response, next: NextFunction) => {
      if (
        req.path.startsWith('/api') ||
        req.path === '/health' ||
        req.path === '/install.sh' ||
        req.path === '/gt'
      ) {
        return next();
      }
      const { distDir, staticHandler } = getDistAndStaticHandler();
      if (!distDir || !staticHandler) {
        return next();
      }

      if (req.method === 'GET' || req.method === 'HEAD') {
        let decodedPath: string;
        try {
          decodedPath = decodeURIComponent(req.path || '/');
        } catch {
          return next();
        }
        if (!decodedPath.includes('\0')) {
          const resolvedRoot = path.resolve(distDir);
          const relTarget = decodedPath === '/' ? 'index.html' : decodedPath.replace(/^\/+/, '');
          const candidate = path.resolve(resolvedRoot, relTarget);
          if (candidate === resolvedRoot || candidate.startsWith(resolvedRoot + path.sep)) {
            try {
              const stat = await fs.promises.stat(candidate);
              if (stat.isFile()) {
                const rel = path.relative(resolvedRoot, candidate);
                const cacheControl = getCacheControlForAsset(rel, candidate);
                const served = await tryServeCompressed(req, res, candidate, stat, cacheControl);
                if (served) {
                  return;
                }
              }
            } catch {
              // File doesn't exist or not readable; fall through
            }
          }
        }
      }

      staticHandler(req, res, next);
    });

    router.get('*', async (req: Request, res: Response, next: NextFunction) => {
      if (
        req.path.startsWith('/api') ||
        req.path === '/health' ||
        req.path === '/install.sh' ||
        req.path === '/gt' ||
        req.path === '/api/terminal/install' ||
        req.path === '/api/terminal/gt'
      ) {
        return next();
      }

      const { distDir } = getDistAndStaticHandler();
      const indexPath = distDir ? path.join(distDir, 'index.html') : null;
      if (indexPath && fs.existsSync(indexPath)) {
        try {
          const stat = await fs.promises.stat(indexPath);
          if (stat.isFile()) {
            const served = await tryServeCompressed(req, res, indexPath, stat, 'no-cache');
            if (served) {
              return;
            }
          }
        } catch {
          // Fall back to res.sendFile
        }
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(indexPath);
      } else {
        res.status(404).send('UI not built yet. Run npm run build.');
      }
    });
  }

  return router;
}

export default createStaticMiddleware();
