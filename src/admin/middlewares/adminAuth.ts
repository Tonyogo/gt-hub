import { Request, Response, NextFunction } from 'express';
import config from '../../../config/default';

export default function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const secretKey = config.adminSecretKey;

  if (!secretKey) {
    return next();
  }

  const providedKey = req.headers['x-admin-key'] || req.query['x-admin-key'] || req.query.key;
  if (providedKey !== secretKey) {
    res.status(401).json({ error: 'Unauthorized: Invalid x-admin-key' });
    return;
  }

  next();
}
