import { Request, Response } from 'express';
import { terminalHostManager } from '../services/terminalHostManager';
import { getVersionInfo } from '../../shared/version';
import config from '../../server/config/default';

class TerminalHostController {
  public async getHosts(req: Request, res: Response): Promise<void> {
    const hosts = terminalHostManager.getHosts();
    res.json({ hosts, timezone: config.timeZone });
  }

  public async pruneOfflineHosts(req: Request, res: Response): Promise<void> {
    const prunedIds = terminalHostManager.pruneOfflineHosts(0);
    res.json({
      success: true,
      prunedCount: prunedIds.length,
      prunedIds,
    });
  }

  public async getVersion(req: Request, res: Response): Promise<void> {
    res.json({ ...getVersionInfo(), timezone: config.timeZone });
  }
}

export const terminalHostController = new TerminalHostController();
export default terminalHostController;

