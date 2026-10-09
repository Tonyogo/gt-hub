import { Router } from 'express';
import { DownloadController } from './downloadController';

const router = Router();

router.get(['/install.sh', '/api/terminal/install'], DownloadController.getInstallScript);
router.get(['/gt', '/api/terminal/gt'], DownloadController.getGtBundle);

export default router;
