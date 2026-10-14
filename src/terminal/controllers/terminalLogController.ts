import { Request, Response } from 'express';
import terminalLogService from '../services/terminalLogService';
import config from '../../server/config/default';
import { safeCompareSecret } from '../../shared/utils/security';
import { ticketManager } from '../../server/modules/auth/ticketManager';

class TerminalLogController {
  public async getTerminalLogs(req: Request, res: Response): Promise<void> {
    const secretKey = config.adminSecretKey;
    if (secretKey) {
      const ticketParam = req.query.ticket as string | undefined;
      let authorized = false;

      if ((req as any).ticketAuthenticated || (ticketParam && ticketManager.consumeTicket(ticketParam))) {
        authorized = true;
      } else {
        const rawProvidedKey = req.headers['x-admin-key'] || req.query['x-admin-key'] || req.query.key;
        const providedKey = Array.isArray(rawProvidedKey) ? rawProvidedKey[0] : rawProvidedKey;
        if (safeCompareSecret(providedKey, secretKey)) {
          authorized = true;
        }
      }

      if (!authorized) {
        res.status(401).json({ error: 'Unauthorized: Invalid credentials or ticket' });
        return;
      }
    }

    const isStream = req.query.stream === 'true' || req.headers.accept === 'text/event-stream';

    if (isStream) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const logs = terminalLogService.getHistory();
      res.write('data: ' + JSON.stringify({ type: 'history', logs }) + '\n\n');

      const onLog = (log: any) => {
        res.write('data: ' + JSON.stringify({ type: 'log', log }) + '\n\n');
      };

      terminalLogService.on('log', onLog);

      req.on('close', () => {
        terminalLogService.off('log', onLog);
      });
    } else {
      res.json({ logs: terminalLogService.getHistory() });
    }
  }
}

export const terminalLogController = new TerminalLogController();
export default terminalLogController;
