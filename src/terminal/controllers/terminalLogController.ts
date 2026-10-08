import { Request, Response } from 'express';
import terminalLogService from '../services/terminalLogService';

class TerminalLogController {
  public async getTerminalLogs(req: Request, res: Response): Promise<void> {
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
