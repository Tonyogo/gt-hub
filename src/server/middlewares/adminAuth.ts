import { Request, Response, NextFunction } from 'express';
import config from '../config/default';
import { safeCompareSecret } from '../../shared/utils/security';

export function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const secretKey = config.adminSecretKey;

  if (!secretKey) {
    return next();
  }

  const rawProvidedKey = req.headers['x-admin-key'] || req.query['x-admin-key'] || req.query.key;
  const providedKey = Array.isArray(rawProvidedKey) ? rawProvidedKey[0] : rawProvidedKey;

  if (!safeCompareSecret(providedKey, secretKey)) {
    res.status(401).json({ error: 'Unauthorized: Invalid x-admin-key' });
    return;
  }

  next();
}

export default adminAuthMiddleware;
