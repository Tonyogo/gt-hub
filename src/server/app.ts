import express, { Request, Response } from 'express';
import downloadRoutes from './modules/download/downloadRoutes';
import authRoutes from './modules/auth/authRoutes';
import terminalRoutes from '../terminal/routes/terminalRoutes';
import staticMiddleware from './modules/static/staticMiddleware';
import errorHandlerMiddleware from './middlewares/errorHandler';
import { getVersionInfo } from '../shared/version';

const app = express();

app.use(express.json({ limit: '50mb' }));

// Public direct download endpoints (/install.sh, /gt, etc.)
app.use(downloadRoutes);

// Auth endpoints (/api/auth)
app.use('/api/auth', authRoutes);

// Terminal API endpoints
app.use('/api/terminal', terminalRoutes);
app.use('/api/admin/terminal', terminalRoutes); // Compatibility alias

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
