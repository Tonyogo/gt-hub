import { createWebSocketAdapter } from '../../shared/utils/wsAdapter';
import { resolveWsEndpointUrl } from '../utils/terminalUI';
import { PROTOCOL_VERSION } from '../../shared/protocol/events';
import { isBinaryMessageFrame, sendWsSafe } from '../../shared/protocol/binaryProtocol';

export function getWebSocketCtor(): any {
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

  return new Promise((resolve) => {
    const { tty, timeoutMs, workdir, env } = options;
    const isTTY = Boolean(process.stdin.isTTY);

    const targetUrl = resolveWsEndpointUrl(serverUrl, '/api/terminal/exec-ws', { hostId });
    const headers: Record<string, any> = {};
    if (apiKey) headers['x-admin-key'] = apiKey;

    let ws: any;
    try {
      ws = new WebSocket(targetUrl, { headers });
    } catch (err: any) {
      console.error(`\n[Error] Connection error: ${err?.message || err}`);
      resolve(1);
      return;
    }

    let settled = false;
    let isTerminated = false;
    let terminalRestored = false;
    let rawModeEnabled = false;
    let supportsStdinEof = false;
    let inputPipelineStarted = false;
    let eofSent = false;
    let execStartedFallbackTimer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let lastActivityAt = Date.now();
    let attachedStdin = false;
    let attachedStdinEnd = false;
    let attachedResize = false;

    const restoreTerminal = () => {
      if (terminalRestored) return;
      terminalRestored = true;
      if (rawModeEnabled && isTTY && process.stdin.setRawMode) {
        try { process.stdin.setRawMode(false); } catch {}
        rawModeEnabled = false;
      }
      if (attachedStdin || attachedStdinEnd || rawModeEnabled) {
        try { process.stdin.pause(); } catch {}
      }
      if (tty) {
        process.stdout.write('\x1b[?25h\x1b[0m');
      }
    };

    const sendEof = () => {
      if (eofSent) return;
      if (!ws || (ws.readyState !== 1 && ws.readyState !== WebSocket.OPEN)) return;
      eofSent = true;
      if (supportsStdinEof) {
        sendWsSafe(ws, JSON.stringify({ type: 'exec_stdin_eof' }), { binary: false, compress: false });
      } else {
        sendWsSafe(ws, Buffer.from([0x04]), { binary: true, compress: false });
      }
    };

    const onStdinData = (chunk: Buffer | string) => {
      if (ws && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN)) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8');
        if (buf.length > 0) {
          sendWsSafe(ws, buf, { binary: true, compress: false });
        }
      }
    };

    const onStdinEnd = () => {
      sendEof();
    };

    const onResize = () => {
      if (ws && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN)) {
        sendWsSafe(ws, JSON.stringify({
          type: 'resize',
          cols: process.stdout.columns || 80,
          rows: process.stdout.rows || 24,
        }), { binary: false, compress: false });
      }
    };

    const startInputPipeline = (stdinEofCapable: boolean) => {
      if (inputPipelineStarted || settled) return;
      inputPipelineStarted = true;
      supportsStdinEof = stdinEofCapable;
      if (execStartedFallbackTimer) {
        clearTimeout(execStartedFallbackTimer);
        execStartedFallbackTimer = null;
      }

      if (tty && isTTY && process.stdin.setRawMode) {
        try {
          process.stdin.setRawMode(true);
          rawModeEnabled = true;
        } catch {}
      }

      attachedStdin = true;
      process.stdin.on('data', onStdinData);

      if (!tty || !isTTY) {
        if (process.stdin.readableEnded) {
          sendEof();
        } else {
          attachedStdinEnd = true;
          process.stdin.on('end', onStdinEnd);
          process.stdin.on('close', onStdinEnd);
        }
      }

      try {
        process.stdin.resume();
      } catch {}

      if ((!tty || !isTTY) && process.stdin.readableEnded) {
        sendEof();
      }

      attachedResize = true;
      process.stdout.on('resize', onResize);
    };

    const forwardKillAndExit = (signal: 'SIGINT' | 'SIGTERM', exitCode: number) => {
      cleanup();
      const isOpen = ws && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN);
      if (!isOpen) {
        try { ws?.terminate?.() ?? ws?.close?.(); } catch {}
        process.exit(exitCode);
        return;
      }
      const killPayload = JSON.stringify({ type: 'exec_kill', signal });
      if (ws._sender && typeof ws._sender === 'object' && typeof ws.send === 'function') {
        let exited = false;
        const doExit = () => {
          if (exited) return;
          exited = true;
          try { ws.close(); } catch {}
          process.exit(exitCode);
        };
        const timer = setTimeout(doExit, 80);
        if (typeof timer.unref === 'function') timer.unref();
        try {
          ws.send(killPayload, { binary: false, compress: false }, () => {
            clearTimeout(timer);
            doExit();
          });
        } catch {
          clearTimeout(timer);
          doExit();
        }
      } else {
        try {
          sendWsSafe(ws, killPayload, { binary: false, compress: false });
          ws.close();
        } catch {}
        process.exit(exitCode);
      }
    };

    const onSigint = () => {
      if (isTerminated) process.exit(130);
      isTerminated = true;
      forwardKillAndExit('SIGINT', 130);
    };

    const onSigterm = () => {
      isTerminated = true;
      forwardKillAndExit('SIGTERM', 143);
    };

    const cleanup = () => {
      if (execStartedFallbackTimer) {
        clearTimeout(execStartedFallbackTimer);
        execStartedFallbackTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (attachedStdin) {
        process.stdin.removeListener('data', onStdinData);
        attachedStdin = false;
      }
      if (attachedStdinEnd) {
        process.stdin.removeListener('end', onStdinEnd);
        process.stdin.removeListener('close', onStdinEnd);
        attachedStdinEnd = false;
      }
      if (attachedResize) {
        process.stdout.removeListener('resize', onResize);
        attachedResize = false;
      }
      process.removeListener('SIGINT', onSigint);
      process.removeListener('SIGTERM', onSigterm);
      restoreTerminal();
    };

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        if (ws && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN)) {
          ws.close(1000, 'Done');
        }
      } catch {}
      resolve(code);
    };

    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);

    ws.on('pong', () => {
      lastActivityAt = Date.now();
    });

    ws.on('open', () => {
      lastActivityAt = Date.now();
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;

      // 1. Send exec_start
      sendWsSafe(ws, JSON.stringify({
        type: 'exec_start',
        protocolVersion: PROTOCOL_VERSION,
        command: fullCommand,
        cwd: workdir,
        env,
        timeoutMs: timeoutMs || 0,
        tty: Boolean(tty),
        interactive: true,
        cols,
        rows,
      }), { binary: false, compress: false });

      // 2. Keepalive heartbeat
      heartbeatTimer = setInterval(() => {
        if (ws.readyState !== 1 && ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastActivityAt > 45000) {
          try { ws.terminate?.() ?? ws.close(); } catch {}
          return;
        }
        try {
          if (typeof ws.ping === 'function') {
            ws.ping();
          }
          sendWsSafe(ws, JSON.stringify({ type: 'ping' }), { binary: false, compress: false });
        } catch {}
      }, 15000);
      if (typeof heartbeatTimer.unref === 'function') {
        heartbeatTimer.unref();
      }

      // 3. Wait for exec_started capability negotiation before attaching stdin (3s fallback for legacy servers)
      execStartedFallbackTimer = setTimeout(() => {
        execStartedFallbackTimer = null;
        startInputPipeline(false);
      }, 3000);
      if (typeof execStartedFallbackTimer.unref === 'function') {
        execStartedFallbackTimer.unref();
      }
    });

    ws.on('message', (data: any, isBinary?: boolean) => {
      lastActivityAt = Date.now();
      if (isBinary === true) {
        process.stdout.write(data);
        return;
      }

      const str = typeof data === 'string' ? data : data.toString('utf-8');
      if (str.includes('[Host Offline]') || str.includes('[Agent Disconnected]')) {
        process.stderr.write(str);
        return;
      }

      if (!isBinaryMessageFrame(data, isBinary) || isBinary === undefined) {
        try {
          const json = JSON.parse(str);
          if (json && typeof json === 'object' && !Array.isArray(json)) {
            if (json.type === 'exec_exit') {
              finish(json.exitCode !== undefined ? json.exitCode : 0);
              return;
            }
            if (json.type === 'exec_started') {
              startInputPipeline(Boolean(json.capabilities?.stdinEof));
              return;
            }
            if (json.type === 'pong') {
              return;
            }
            if (json.type === 'exec_error') {
              if (json.error) {
                process.stderr.write(`\n[Error] ${json.error}\n`);
              }
              finish(typeof json.exitCode === 'number' ? json.exitCode : 1);
              return;
            }
          }
        } catch {}
      }

      process.stdout.write(data);
    });

    ws.on('unexpected-response', (req: any, res: any) => {
      const statusCode = res?.statusCode || 0;
      if (!settled) {
        process.stderr.write(`\n[Error] WebSocket upgrade failed with HTTP ${statusCode}\n`);
      }
      finish(1);
      try { res?.resume?.(); } catch {}
      try { req?.destroy?.(); } catch {}
      try { ws?.terminate?.(); } catch {}
    });

    ws.on('error', (err: any) => {
      if (!settled) {
        console.error(`\n[Error] Connection error: ${err.message}`);
      }
      finish(1);
    });

    ws.on('close', (code: number, reason: any) => {
      if (settled) {
        cleanup();
        return;
      }
      if (code === 1000) {
        finish(0);
      } else {
        console.error(`\n[Connection Closed] ${reason?.toString() || `code ${code}`}`);
        finish(1);
      }
    });
  });
}
