import { Request, Response } from 'express';
import config from '../../config/default';
import { safeCompareSecret } from '../../../shared/utils/security';

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

    const { key } = req.body || {};
    if (safeCompareSecret(key, secretKey)) {
      res.status(200).json({ success: true });
    } else {
      res.status(401).json({ error: 'Unauthorized: Invalid secret key' });
    }
  }
}
