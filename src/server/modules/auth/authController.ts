import { Request, Response } from 'express';
import config from '../../config/default';

export class AuthController {
  static getStatus(req: Request, res: Response): void {
    const secretKey = config.adminSecretKey;
    if (!secretKey) {
      res.status(200).json({ authRequired: false, authenticated: true });
      return;
    }

    const providedKey = req.headers['x-admin-key'] || req.query['x-admin-key'] || req.query.key;
    const authenticated = providedKey === secretKey;

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
    if (key === secretKey) {
      res.status(200).json({ success: true });
    } else {
      res.status(401).json({ error: 'Unauthorized: Invalid secret key' });
    }
  }
}
