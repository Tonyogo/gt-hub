import { Router } from 'express';
import { AuthController } from './authController';
import adminAuthMiddleware from '../../middlewares/adminAuth';

const router = Router();

router.get('/status', AuthController.getStatus);
router.post('/login', AuthController.login);
router.post('/ticket', adminAuthMiddleware, AuthController.createTicket);

export default router;
