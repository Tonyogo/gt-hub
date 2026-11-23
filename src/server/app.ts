import express, { Request, Response } from 'express';
import downloadRoutes from './modules/download/downloadRoutes';
import authRoutes from './modules/auth/authRoutes';
import terminalRoutes from '../terminal/routes/terminalRoutes';
import proxyRoutes from '../terminal/routes/proxyRoutes';
import scriptRoutes from './modules/scripts/scriptRoutes';
import staticMiddleware from './modules/static/staticMiddleware';
import errorHandlerMiddleware from './middlewares/errorHandler';
import compressionMiddleware from './middlewares/compressionMiddleware';
import { getVersionInfo } from '../shared/version';
import { parseTrustProxySetting } from './modules/auth/rateLimiter';

export { parseTrustProxySetting };

const app = express();

const trustProxySetting = parseTrustProxySetting(process.env.TRUST_PROXY);
if (trustProxySetting) {
  app.set('trust proxy', trustProxySetting);
}
app.disable('x-powered-by');

// Security headers middleware
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const rawAncestors = process.env.GT_FRAME_ANCESTORS?.trim();
  const isStrict = process.env.GT_STRICT_FRAME_ANCESTORS === 'true';
  if (rawAncestors) {
    const extraTokens = rawAncestors.split(/[\s,]+/).filter(Boolean).join(' ');
    const extraAncestors = extraTokens ? ` ${extraTokens}` : '';
    res.setHeader('Content-Security-Policy', `frame-ancestors 'self'${extraAncestors}`);
  } else if (isStrict) {
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  }
  next();
});

// Proxy API endpoints (mounted before express.json to preserve request stream)
app.use('/api/proxy', proxyRoutes);
app.use('/api/admin/proxy', proxyRoutes);

app.use(express.json({ limit: '10mb' }));
app.use(compressionMiddleware);

// Public direct download endpoints (/install.sh, /gt, etc.)
app.use(downloadRoutes);

// Auth endpoints (/api/auth)
app.use('/api/auth', authRoutes);

// Terminal API endpoints
app.use('/api/terminal', terminalRoutes);
app.use('/api/admin/terminal', terminalRoutes); // Compatibility alias

// Script API endpoints
app.use('/api/admin/scripts', scriptRoutes);
app.use('/api/scripts', scriptRoutes);

// Server Health check
app.get('/health', (req: Request, res: Response) => {
  const info = getVersionInfo();
  res.status(200).json({ status: 'ok', version: info.version });
});

// Frontend UI static files & SPA fallback
app.use(staticMiddleware);

// Global error handler
app.use(errorHandlerMiddleware);

export default app;
