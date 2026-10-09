import { Router } from 'express';
import { AuthController } from './authController';

const router = Router();

router.get('/status', AuthController.getStatus);
router.post('/login', AuthController.login);

export default router;
