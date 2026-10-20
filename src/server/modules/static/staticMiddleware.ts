import express, { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import path from 'path';
import fs from 'fs';
import config from '../../config/default';

let cachedFrontendDist: string | null = null;
let cachedStaticHandler: RequestHandler | null = null;

function resolveFrontendDist(): string | null {
  if (cachedFrontendDist && fs.existsSync(cachedFrontendDist)) {
    return cachedFrontendDist;
  }

  const candidates = [
    path.join(__dirname, '../../../../dist/frontend'),
    path.join(__dirname, '../../../dist/frontend'),
    path.join(__dirname, '../../dist/frontend'),
    path.join(process.cwd(), 'dist/frontend'),
    path.join(process.cwd(), 'frontend'),
  ];
  const found = candidates.find((p) => fs.existsSync(p)) || null;
  if (found !== cachedFrontendDist) {
    cachedFrontendDist = found;
    cachedStaticHandler = found ? express.static(found) : null;
  }
  return found;
}

const router = Router();

if (config.enableUi) {
  router.use((req: Request, res: Response, next: NextFunction) => {
    const frontendDist = resolveFrontendDist();
    if (frontendDist && cachedStaticHandler) {
      cachedStaticHandler(req, res, next);
    } else {
      next();
    }
  });

  router.get('*', (req: Request, res: Response, next: NextFunction) => {
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
    const frontendDist = resolveFrontendDist();
    if (frontendDist && fs.existsSync(path.join(frontendDist, 'index.html'))) {
      res.sendFile(path.join(frontendDist, 'index.html'));
    } else {
      res.status(404).send('UI not built yet. Run npm run build.');
    }
  });
}

export default router;
