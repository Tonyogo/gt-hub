import { Request, Response } from 'express';
import { terminalHostManager } from '../services/terminalHostManager';

class TerminalHostController {
  public async getHosts(req: Request, res: Response): Promise<void> {
    const hosts = terminalHostManager.getHosts();
    res.json({ hosts });
  }

  public async pruneOfflineHosts(req: Request, res: Response): Promise<void> {
    const prunedIds = terminalHostManager.pruneOfflineHosts(0);
    res.json({
      success: true,
      prunedCount: prunedIds.length,
      prunedIds,
    });
  }
}

export const terminalHostController = new TerminalHostController();
export default terminalHostController;
