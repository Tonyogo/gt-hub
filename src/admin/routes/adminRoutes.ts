import { Router } from 'express';
import terminalRoutes from '../../terminal/routes/terminalRoutes';

const router = Router();
router.use('/terminal', terminalRoutes);

export default router;
