import { Request, Response } from 'express';
import config from '../../config/default';
import { safeCompareSecret } from '../../../shared/utils/security';
import { ticketManager } from './ticketManager';
import { loginRateLimiter } from './rateLimiter';

export class AuthController {
  static getStatus(req: Request, res: Response): void {
    const secretKey = config.adminSecretKey;
    if (!secretKey) {
      res.status(200).json({ authRequired: false, authenticated: true });
      return;
    }

    const rawProvidedKey = req.headers['x-admin-key'] || req.query['x-admin-key'] || req.query.key;
    const providedKey = Array.isArray(rawProvidedKey) ? rawProvidedKey[0] : rawProvidedKey;
    const authenticated = safeCompareSecret(providedKey, secretKey);

    res.status(200).json({
      authRequired: true,
      authenticated,
    });
  }

  static login(req: Request, res: Response): void {
    const secretKey = config.adminSecretKey;
    if (!secretKey) {
      res.status(200).json({ success: true });
      return;
    }

    const clientIp = req.ip || req.socket?.remoteAddress || 'unknown';
    const rateStatus = loginRateLimiter.isRateLimited(clientIp);
    if (rateStatus.limited) {
      res.setHeader('Retry-After', String(rateStatus.retryAfterSec));
      res.status(429).json({
        error: `Too many failed login attempts. Please try again in ${rateStatus.retryAfterSec} seconds.`,
      });
      return;
    }

    const { key } = req.body || {};
    if (safeCompareSecret(key, secretKey)) {
      loginRateLimiter.clear(clientIp);
      res.status(200).json({ success: true });
    } else {
      loginRateLimiter.recordFailure(clientIp);
      res.status(401).json({ error: 'Unauthorized: Invalid secret key' });
    }
  }

  static createTicket(req: Request, res: Response): void {
    const isReusable = req.query.reusable === '1' || req.query.reusable === 'true' || req.body?.reusable === true;
    const ticket = ticketManager.createTicket(
      isReusable ? { reusable: true } : undefined,
      isReusable ? 60000 : undefined,
      isReusable
    );
    res.status(200).json({
      success: true,
      ticket,
      expiresIn: isReusable ? 60 : 30,
    });
  }
}
