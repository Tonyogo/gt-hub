import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import terminalRoutes from './terminal/routes/terminalRoutes';
import authRoutes from './auth/routes/authRoutes';
import config from '../config/default';

const app = express();

app.use(express.json({ limit: '50mb' }));

function resolveScriptFile(filename: string): string | null {
  const candidates = [
    path.join(__dirname, '../scripts', filename),
    path.join(__dirname, '../../scripts', filename),
    path.join(process.cwd(), 'scripts', filename),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Public direct download endpoints for gt CLI and installer
app.get(['/install.sh', '/api/terminal/install'], (req: Request, res: Response) => {
  const scriptPath = resolveScriptFile('install-gt.sh');
  if (scriptPath) {
    res.sendFile(scriptPath);
  } else {
    res.status(404).send('Installer script not found.');
  }
});

app.get(['/gt', '/api/terminal/gt'], (req: Request, res: Response) => {
  const scriptPath = resolveScriptFile('gt.js');
  if (scriptPath) {
    res.sendFile(scriptPath);
  } else {
    res.status(404).send('gt.js script not found.');
  }
});

app.use('/api/terminal', terminalRoutes);
// Compatibility alias
app.use('/api/admin/terminal', terminalRoutes);
app.use('/api/auth', authRoutes);

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

function resolveFrontendDist(): string | null {
  const candidates = [
    path.join(__dirname, '../dist/frontend'),
    path.join(__dirname, '../../dist/frontend'),
    path.join(process.cwd(), 'dist/frontend'),
    path.join(__dirname, '../frontend'),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

if (config.enableUi) {
  app.use((req: Request, res: Response, next) => {
    const frontendDist = resolveFrontendDist();
    if (frontendDist) {
      express.static(frontendDist)(req, res, next);
    } else {
      next();
    }
  });

  app.get('*', (req: Request, res: Response, next) => {
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

export default app;
