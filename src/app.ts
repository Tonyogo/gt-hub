import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import terminalRoutes from './terminal/routes/terminalRoutes';
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

app.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

if (config.enableUi) {
  const frontendDist = path.join(__dirname, '../../dist/frontend');
  app.use(express.static(frontendDist));
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
    res.sendFile(path.join(frontendDist, 'index.html'), (err) => {
      if (err) {
        res.status(404).send('UI not built yet. Run npm run build.');
      }
    });
  });
}

export default app;
