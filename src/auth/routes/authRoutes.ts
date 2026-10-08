import { Router, Request, Response } from 'express';
import config from '../../../config/default';

const router = Router();

router.get('/status', (req: Request, res: Response) => {
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
});

router.post('/login', (req: Request, res: Response) => {
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
});

export default router;
