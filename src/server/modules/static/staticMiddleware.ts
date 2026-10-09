import express, { Router, Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import config from '../../config/default';

function resolveFrontendDist(): string | null {
  const candidates = [
    path.join(__dirname, '../../../../dist/frontend'),
    path.join(__dirname, '../../../dist/frontend'),
    path.join(__dirname, '../../dist/frontend'),
    path.join(process.cwd(), 'dist/frontend'),
    path.join(process.cwd(), 'frontend'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

const router = Router();

if (config.enableUi) {
  router.use((req: Request, res: Response, next: NextFunction) => {
    const frontendDist = resolveFrontendDist();
    if (frontendDist) {
      express.static(frontendDist)(req, res, next);
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
