import { Router, Request, Response } from 'express';
import { ScriptService, scriptService as defaultService } from './scriptService';
import adminAuthMiddleware from '../../middlewares/adminAuth';

export function createScriptRouter(service: ScriptService = defaultService): Router {
  const router = Router();

  router.use(adminAuthMiddleware);

  // List all scripts
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    try {
      const data = await service.listScripts();
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message || 'Failed to list scripts' });
    }
  });

  // Get script detail
  router.get('/:name', async (req: Request, res: Response): Promise<void> => {
    try {
      const name = String(req.params.name);
      const data = await service.getScript(name);
      res.json({ success: true, data });
    } catch (err: any) {
      const status = err.message?.includes('not found') ? 404 : 400;
      res.status(status).json({ success: false, error: err.message || 'Failed to get script' });
    }
  });

  // Create new script
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    try {
      const { name, content } = req.body;
      if (!name || typeof name !== 'string') {
        res.status(400).json({ success: false, error: 'Script name is required' });
        return;
      }
      if (typeof content !== 'string') {
        res.status(400).json({ success: false, error: 'Script content must be a string' });
        return;
      }
      const data = await service.saveScript(name.trim(), content);
      res.status(201).json({ success: true, data });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message || 'Failed to create script' });
    }
  });

  // Update script
  router.put('/:name', async (req: Request, res: Response): Promise<void> => {
    try {
      const name = String(req.params.name);
      const { content } = req.body;
      if (typeof content !== 'string') {
        res.status(400).json({ success: false, error: 'Script content must be a string' });
        return;
      }
      const data = await service.saveScript(name, content);
      res.json({ success: true, data });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message || 'Failed to update script' });
    }
  });

  // Delete script
  router.delete('/:name', async (req: Request, res: Response): Promise<void> => {
    try {
      const name = String(req.params.name);
      await service.deleteScript(name);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ success: false, error: err.message || 'Failed to delete script' });
    }
  });

  return router;
}

export default createScriptRouter();
