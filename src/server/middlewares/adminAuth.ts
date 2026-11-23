import { Request, Response, NextFunction } from 'express';
import config from '../config/default';
import { safeCompareSecret, extractAdminKeyFromRequest } from '../../shared/utils/security';
import { ticketManager } from '../modules/auth/ticketManager';
import { loginRateLimiter, extractClientIp } from '../modules/auth/rateLimiter';

export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const secretKey = config.adminSecretKey;

  if (!secretKey) {
    return next();
  }

  const clientIp = extractClientIp(req);
  const rateStatus = loginRateLimiter.isRateLimited(clientIp);
  if (rateStatus.limited) {
    res.setHeader('Retry-After', String(rateStatus.retryAfterSec));
    res.status(429).json({
      error: `Too many failed attempts. Please try again in ${rateStatus.retryAfterSec} seconds.`,
    });
    return;
  }

  const ticketParam = req.query.ticket;
  if (typeof ticketParam === 'string' && ticketParam && ticketManager.consumeTicket(ticketParam)) {
    loginRateLimiter.clear(clientIp);
    (req as any).ticketAuthenticated = true;
    return next();
  }

  const providedKey = extractAdminKeyFromRequest(req);

  if (!safeCompareSecret(providedKey, secretKey)) {
    loginRateLimiter.recordFailure(clientIp);
    res.status(401).json({ error: 'Unauthorized: Invalid x-admin-key' });
    return;
  }

  loginRateLimiter.clear(clientIp);
  next();
}

export default adminAuthMiddleware;
