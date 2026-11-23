import { Request, Response } from 'express';
import config from '../../config/default';
import { safeCompareSecret, extractAdminKeyFromRequest } from '../../../shared/utils/security';
import { ticketManager } from './ticketManager';
import { loginRateLimiter, extractClientIp } from './rateLimiter';

export function resolveAllowedParentOrigins(): string[] {
  const sources = [
    process.env.GT_FRAME_ANCESTORS,
    process.env.GT_ALLOWED_PARENT_ORIGINS,
  ];
  const result: string[] = [];
  for (const source of sources) {
    if (!source || typeof source !== 'string') continue;
    const tokens = source.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
    for (const token of tokens) {
      if (token === "'self'" || token === "'none'") continue;
      try {
        const url = new URL(token);
        if (url.origin && url.origin !== 'null' && !result.includes(url.origin)) {
          result.push(url.origin);
        }
      } catch {
        // Skip invalid URL / token format
      }
    }
  }
  return result;
}

export class AuthController {
  static getStatus(req: Request, res: Response): void {
    const secretKey = config.adminSecretKey;
    const allowedParentOrigins = resolveAllowedParentOrigins();

    if (!secretKey) {
      res.status(200).json({
        authRequired: false,
        authenticated: true,
        allowedParentOrigins,
      });
      return;
    }

    const providedKey = extractAdminKeyFromRequest(req);
    if (providedKey) {
      const clientIp = extractClientIp(req);
      const rateStatus = loginRateLimiter.isRateLimited(clientIp);
      if (rateStatus.limited) {
        res.setHeader('Retry-After', String(rateStatus.retryAfterSec));
        res.status(429).json({
          error: `Too many failed attempts. Please try again in ${rateStatus.retryAfterSec} seconds.`,
        });
        return;
      }

      const authenticated = safeCompareSecret(providedKey, secretKey);
      if (authenticated) {
        loginRateLimiter.clear(clientIp);
      } else {
        loginRateLimiter.recordFailure(clientIp);
      }

      res.status(200).json({
        authRequired: true,
        authenticated,
        allowedParentOrigins,
      });
      return;
    }

    res.status(200).json({
      authRequired: true,
      authenticated: false,
      allowedParentOrigins,
    });
  }

  static login(req: Request, res: Response): void {
    const secretKey = config.adminSecretKey;
    if (!secretKey) {
      res.status(200).json({ success: true });
      return;
    }

    const clientIp = extractClientIp(req);
    const rateStatus = loginRateLimiter.isRateLimited(clientIp);
    if (rateStatus.limited) {
      res.setHeader('Retry-After', String(rateStatus.retryAfterSec));
      res.status(429).json({
        error: `Too many failed login attempts. Please try again in ${rateStatus.retryAfterSec} seconds.`,
      });
      return;
    }

    const key = (req.body && req.body.key !== undefined) ? req.body.key : extractAdminKeyFromRequest(req);
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
