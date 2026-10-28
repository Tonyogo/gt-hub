import { Router, Request, Response } from 'express';
import { adminAuthMiddleware } from '../../server/middlewares/adminAuth';
import { terminalProxyBridge } from '../services/terminalProxyBridge';

const router = Router();

router.use(adminAuthMiddleware);

router.all(['/:hostId/port/:port', '/:hostId/port/:port/*'], (req: Request, res: Response) => {
  const hostId = Array.isArray(req.params.hostId) ? req.params.hostId[0] : req.params.hostId;
  const portStr = Array.isArray(req.params.port) ? req.params.port[0] : req.params.port;
  const port = parseInt(portStr || '', 10);

  if (isNaN(port) || port < 1 || port > 65535) {
    res.status(400).json({ error: 'Invalid target port number' });
    return;
  }

  const rawSubpath = req.params[0] ? req.params[0].replace(/^\/+/, '') : '';
  const subpath = '/' + rawSubpath;

  const qIdx = req.url.indexOf('?');
  let queryString = '';
  if (qIdx !== -1) {
    const searchParams = new URLSearchParams(req.url.slice(qIdx + 1));
    searchParams.delete('key');
    searchParams.delete('x-admin-key');
    searchParams.delete('ticket');
    const qs = searchParams.toString();
    if (qs) {
      queryString = '?' + qs;
    }
  }

  const targetHost = (req.headers['x-gt-target-host'] as string) || '127.0.0.1';
  const targetProto = (req.headers['x-gt-target-proto'] as string) || 'http';
  const timeoutMs = req.headers['x-gt-timeout']
    ? parseInt(req.headers['x-gt-timeout'] as string, 10)
    : undefined;
  const insecure = req.headers['x-gt-insecure'] === '1' || req.headers['x-gt-insecure'] === 'true';

  const targetUrl = `${targetProto}://${targetHost}:${port}${subpath}${queryString}`;

  terminalProxyBridge.handleHttpProxyRequest(req, res, {
    hostId,
    targetUrl,
    timeoutMs,
    insecure,
  });
});

router.all('/:hostId/request', (req: Request, res: Response) => {
  const hostId = Array.isArray(req.params.hostId) ? req.params.hostId[0] : req.params.hostId;
  const rawUrl = (req.headers['x-gt-target-url'] as string) || (req.query.url as string);

  if (!rawUrl) {
    res.status(400).json({
      error: 'Target URL is required (via x-gt-target-url header or url query parameter)',
    });
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    res.status(400).json({ error: 'Invalid target URL format' });
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.status(400).json({ error: 'Target URL must use http: or https: protocol' });
    return;
  }

  const timeoutMs = req.headers['x-gt-timeout']
    ? parseInt(req.headers['x-gt-timeout'] as string, 10)
    : undefined;
  const insecure = req.headers['x-gt-insecure'] === '1' || req.headers['x-gt-insecure'] === 'true';

  terminalProxyBridge.handleHttpProxyRequest(req, res, {
    hostId,
    targetUrl: rawUrl,
    timeoutMs,
    insecure,
  });
});

export default router;
