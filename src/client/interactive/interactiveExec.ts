import { createWebSocketAdapter } from '../../shared/utils/wsAdapter';

function getWebSocketCtor(): any {
  let wsImpl: any = null;
  try {
    wsImpl = require('ws');
  } catch {}
  if (!wsImpl) {
    wsImpl = createWebSocketAdapter();
  }
  return wsImpl;
}

export interface InteractiveExecOptions {
  serverUrl: string;
  apiKey: string;
  hostId: string;
  fullCommand: string;
  options: {
    tty?: boolean;
    timeoutMs?: number;
    workdir?: string;
    env?: Record<string, string>;
  };
}

export function runInteractiveExec({ serverUrl, apiKey, hostId, fullCommand, options }: InteractiveExecOptions): Promise<number> {
  const WebSocket = getWebSocketCtor();

  return new Promise(async (resolve, reject) => {
    const { tty, timeoutMs, workdir, env } = options;
    const isTTY = Boolean(process.stdin.isTTY);

    let wsUrl = serverUrl.replace(/^http:\/\//i, 'ws://').replace(/^https:\/\//i, 'wss://');
    if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
      wsUrl = `ws://${wsUrl}`;
    }
    wsUrl = wsUrl.replace(/\/+$/, '');

    const query = new URLSearchParams({ hostId });
    if (apiKey) query.set('key', apiKey);

    const targetUrl = `${wsUrl}/api/terminal/exec-ws?${query.toString()}`;
    const headers: Record<string, any> = {};
    if (apiKey) headers['x-admin-key'] = apiKey;

    const ws = new WebSocket(targetUrl, { headers });

    const restoreTerminal = () => {
      if (isTTY && process.stdin.setRawMode) {
        try { process.stdin.setRawMode(false); } catch {}
      }
      try { process.stdin.pause(); } catch {}
      if (tty) {
        process.stdout.write('\x1b[?25h\x1b[0m');
      }
    };

    ws.on('open', () => {
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;

      // 1. Send exec_start
      ws.send(JSON.stringify({
        type: 'exec_start',
        command: fullCommand,
        cwd: workdir,
        env,
        timeoutMs: timeoutMs || 0,
        tty: Boolean(tty),
        interactive: true,
        cols,
        rows,
      }));

      // 2. Set raw mode if TTY
      if (isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
      }

      // 3. Pipe stdin to ws binary
      process.stdin.on('data', (chunk) => {
        if (ws.readyState === 1 || ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      });

      // 4. Handle resize
      const onResize = () => {
        if (ws.readyState === 1 || ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'resize',
            cols: process.stdout.columns || 80,
            rows: process.stdout.rows || 24,
          }));
        }
      };
      process.stdout.on('resize', onResize);
      ws.on('close', () => {
        process.stdout.removeListener('resize', onResize);
      });
    });

    ws.on('message', (data: any, isBinary: boolean) => {
      if (isBinary) {
        process.stdout.write(data);
        return;
      }

      const str = data.toString();
      try {
        const json = JSON.parse(str);
        if (json.type === 'exec_exit') {
          restoreTerminal();
          resolve(json.exitCode !== undefined ? json.exitCode : 0);
          return;
        }
        if (json.type === 'exec_started') {
          return;
        }
      } catch {}

      process.stdout.write(data);
    });

    ws.on('error', (err: any) => {
      restoreTerminal();
      console.error(`\n[Error] Connection error: ${err.message}`);
      resolve(1);
    });

    ws.on('close', (code: number, reason: any) => {
      restoreTerminal();
      if (code !== 1000) {
        console.error(`\n[Connection Closed] ${reason?.toString() || `code ${code}`}`);
        resolve(1);
      }
    });

    process.on('SIGINT', () => {
      restoreTerminal();
      process.exit(130);
    });
  });
}
