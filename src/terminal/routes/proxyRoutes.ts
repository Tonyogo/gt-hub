import crypto from 'crypto';
import { Router, Request, Response, NextFunction } from 'express';
import config from '../../../config/default';
import { safeCompareSecret } from '../../shared/utils/security';
import { ticketManager } from '../../server/modules/auth/ticketManager';
import { terminalProxyBridge } from '../services/terminalProxyBridge';

export function createProxySessionToken(secretKey: string, ttlMs = 12 * 3600 * 1000): string {
  const expiresAt = Date.now() + ttlMs;
  const nonce = crypto.randomBytes(8).toString('hex');
  const payload = `${expiresAt}.${nonce}`;
  const sig = crypto.createHmac('sha256', secretKey).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

export function verifyProxySessionToken(token: string, secretKey: string): boolean {
  if (!token || typeof token !== 'string' || !secretKey) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expiresAtStr, nonce, sig] = parts;
  const expiresAt = parseInt(expiresAtStr, 10);
  if (isNaN(expiresAt) || expiresAt <= Date.now()) {
    return false;
  }
  const payload = `${expiresAtStr}.${nonce}`;
  const expectedSig = crypto.createHmac('sha256', secretKey).update(payload).digest('hex');
  return safeCompareSecret(sig, expectedSig);
}

function parseCookieHeader(cookieStr: string | string[] | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!cookieStr) return map;
  const raw = Array.isArray(cookieStr) ? cookieStr.join('; ') : cookieStr;
  const parts = raw.split(';');
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx !== -1) {
      const k = part.slice(0, eqIdx).trim();
      const v = part.slice(eqIdx + 1).trim();
      map[k] = v;
    }
  }
  return map;
}

export function proxyAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const secretKey = config.adminSecretKey;
  if (!secretKey) {
    return next();
  }

  // 1. Check header x-admin-key
  const headerKey = req.headers['x-admin-key'];
  if (headerKey && safeCompareSecret(headerKey, secretKey)) {
    return next();
  }

  // 2. Check query key / x-admin-key
  const queryKey = (req.query.key as string) || (req.query['x-admin-key'] as string);
  if (queryKey && safeCompareSecret(queryKey, secretKey)) {
    const token = createProxySessionToken(secretKey);
    res.setHeader('Set-Cookie', `gt_proxy_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
    return next();
  }

  // 3. Check query ticket
  const ticket = req.query.ticket as string;
  if (ticket && ticketManager.consumeTicket(ticket)) {
    const token = createProxySessionToken(secretKey);
    res.setHeader('Set-Cookie', `gt_proxy_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`);
    return next();
  }

  // 4. Check gt_proxy_session cookie
  const cookies = parseCookieHeader(req.headers.cookie);
  const sessionToken = cookies['gt_proxy_session'];
  if (sessionToken && verifyProxySessionToken(sessionToken, secretKey)) {
    return next();
  }

  res.status(401).json({ error: 'Unauthorized: Invalid x-admin-key or proxy session' });
}

const router = Router();

router.use(proxyAuthMiddleware);

router.get('/:hostId/ports', async (req: Request, res: Response) => {
  const hostId = Array.isArray(req.params.hostId) ? req.params.hostId[0] : req.params.hostId;
  const timeoutMs = req.query.timeout ? parseInt(req.query.timeout as string, 10) : undefined;

  const result = await terminalProxyBridge.listListeningPorts(hostId, timeoutMs);
  if (!result.success) {
    res.status(result.status || 500).json({ error: result.error || 'Failed to list ports' });
    return;
  }

  res.status(200).json({ ports: result.ports || [] });
});

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

  let targetHost = (req.headers['x-gt-target-host'] as string) || '127.0.0.1';
  let targetProto = (req.headers['x-gt-target-proto'] as string) || 'http';

  const qIdx = req.url.indexOf('?');
  let queryString = '';
  if (qIdx !== -1) {
    const searchParams = new URLSearchParams(req.url.slice(qIdx + 1));
    const queryHost = searchParams.get('_gt_host');
    const queryProto = searchParams.get('_gt_proto');
    if (queryHost) {
      targetHost = queryHost;
    }
    if (queryProto) {
      targetProto = queryProto;
    }
    searchParams.delete('key');
    searchParams.delete('x-admin-key');
    searchParams.delete('ticket');
    searchParams.delete('_gt_host');
    searchParams.delete('_gt_proto');
    const qs = searchParams.toString();
    if (qs) {
      queryString = '?' + qs;
    }
  }

  if (targetProto !== 'http' && targetProto !== 'https') {
    res.status(400).json({ error: 'Target protocol must be http or https' });
    return;
  }

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
