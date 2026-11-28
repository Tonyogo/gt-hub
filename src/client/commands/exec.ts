import { quoteShellArg, resolveHost, resolveWsEndpointUrl, makeRequest } from '../utils/terminalUI';
import { runInteractiveExec, getWebSocketCtor } from '../interactive/interactiveExec';
import { PROTOCOL_VERSION } from '../../shared/protocol/events';
import { isBinaryMessageFrame, sendWsSafe } from '../../shared/protocol/binaryProtocol';

export interface ExecParsedArgs {
  host: string;
  fullCommand: string;
  commandParts: string[];
  options: {
    detach: boolean;
    workdir?: string;
    timeoutMs: number;
    verbose: boolean;
    pollInterval: number;
    env: Record<string, string>;
    interactive: boolean;
    tty: boolean;
    mode: 'stream' | 'poll';
  };
}

export function parseExecArgs(args: string[]): ExecParsedArgs {
  let detach = false;
  let workdir: string | undefined = undefined;
  let timeoutMs = 300000;
  let verbose = false;
  let pollInterval = 500;
  let interactive = false;
  let tty = false;
  const rawModeEnv = (process.env.GT_EXEC_MODE || '').trim().toLowerCase();
  let mode: 'stream' | 'poll' = rawModeEnv === 'poll' ? 'poll' : 'stream';
  const envVars: Record<string, string> = {};
  let host = '';
  const commandParts: string[] = [];

  const hasDoubleDash = args.includes('--');
  let i = 0;
  // Phase 1: parse gt exec options until host is found or -- is encountered
  while (i < args.length) {
    const a = args[i];
    if (a === '--') {
      i++;
      if (!host && i < args.length) {
        host = args[i++];
      }
      break;
    }
    if (a === '-d' || a === '--detach' || a === '-a' || a === '--async') {
      detach = true;
    } else if (a === '--poll') {
      mode = 'poll';
    } else if (a === '--stream') {
      mode = 'stream';
    } else if (a === '--verbose') {
      verbose = true;
    } else if (a === '-q' || a === '--quiet') {
      // Retained for backward flag compatibility
    } else if (a === '-it' || a === '-ti') {
      interactive = true;
      tty = true;
    } else if (a === '-i' || a === '--interactive' || a === '--stdin') {
      interactive = true;
    } else if (a === '-t' || a === '--tty') {
      tty = true;
    } else if (a === '-w' || a === '--workdir' || a === '--cwd') {
      workdir = args[++i];
    } else if (a.startsWith('-w=')) {
      workdir = a.slice(3);
    } else if (a.startsWith('--workdir=')) {
      workdir = a.slice(10);
    } else if (a.startsWith('--cwd=')) {
      workdir = a.slice(6);
    } else if (a === '--timeout') {
      timeoutMs = parseInt(args[++i], 10);
    } else if (a.startsWith('--timeout=')) {
      timeoutMs = parseInt(a.slice(10), 10);
    } else if (a === '--poll-interval') {
      pollInterval = parseInt(args[++i], 10);
    } else if (a === '-e' || a === '--env') {
      const pair = args[++i] || '';
      const eq = pair.indexOf('=');
      if (eq !== -1) {
        envVars[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    } else if (a.startsWith('-e=')) {
      const pair = a.slice(3);
      const eq = pair.indexOf('=');
      if (eq !== -1) envVars[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    } else if (a.startsWith('-')) {
      throw new Error(`Unknown option before host: ${a}`);
    } else if (!host) {
      host = a;
      if (!hasDoubleDash) {
        i++;
        break;
      }
    } else {
      commandParts.push(a);
      i++;
      break;
    }
    i++;
  }

  // If a double dash directly follows host (e.g. gt exec node-1 -- cmd), skip it
  if (i < args.length && args[i] === '--') {
    i++;
  }

  // Phase 2: everything after host is remote command arguments
  while (i < args.length) {
    commandParts.push(args[i++]);
  }

  const fullCommand = commandParts.length === 1
    ? commandParts[0].trim()
    : commandParts.map(quoteShellArg).join(' ').trim();

  return {
    host,
    fullCommand,
    commandParts,
    options: { detach, workdir, timeoutMs, verbose, pollInterval, env: envVars, interactive, tty, mode },
  };
}

export class StreamExecError extends Error {
  public readonly allowHttpFallback: boolean;
  public readonly statusCode?: number;

  constructor(message: string, allowHttpFallback: boolean, statusCode?: number) {
    super(message);
    this.name = 'StreamExecError';
    this.allowHttpFallback = allowHttpFallback;
    this.statusCode = statusCode;
  }
}

export function runStreamExec({
  serverUrl,
  apiKey,
  hostId,
  fullCommand,
  options,
  stdinPayload,
  startTime,
}: {
  serverUrl: string;
  apiKey: string;
  hostId: string;
  fullCommand: string;
  options: ExecParsedArgs['options'];
  stdinPayload?: string;
  startTime: number;
}): Promise<number> {
  const WebSocket = getWebSocketCtor();

  return new Promise((resolve, reject) => {
    const { timeoutMs, workdir, env, verbose } = options;
    const targetUrl = resolveWsEndpointUrl(serverUrl, '/api/terminal/exec-ws', { hostId });
    const headers: Record<string, any> = {};
    if (apiKey) headers['x-admin-key'] = apiKey;

    let ws: any;
    try {
      ws = new WebSocket(targetUrl, { headers });
    } catch (err: any) {
      return reject(new StreamExecError(err?.message || String(err), true));
    }

    let isConnected = false;
    let isTerminated = false;
    let exitResolved = false;
    let execStarted = false;
    let supportsStdinEof: boolean | null = null;
    let inputPipelineStarted = false;
    let eofSent = false;
    let stdinBytesSent = 0;
    let receivedServerOutput = false;
    let execStartedFallbackTimer: NodeJS.Timeout | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let lastActivityAt = Date.now();
    let attachedStdinListeners = false;

    const hasExecutionStarted = () => execStarted || stdinBytesSent > 0 || receivedServerOutput;

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
          stdinBytesSent += buf.length;
          sendWsSafe(ws, buf, { binary: true, compress: false });
        }
      }
    };

    const onStdinEnd = () => {
      sendEof();
    };

    const startInputPipeline = (stdinEofCapable: boolean) => {
      if (inputPipelineStarted || exitResolved) return;
      inputPipelineStarted = true;
      supportsStdinEof = stdinEofCapable;
      if (execStartedFallbackTimer) {
        clearTimeout(execStartedFallbackTimer);
        execStartedFallbackTimer = null;
      }

      if (stdinPayload !== undefined) {
        if (stdinPayload.length > 0) {
          const payloadBuf = Buffer.from(stdinPayload, 'utf-8');
          stdinBytesSent += payloadBuf.length;
          sendWsSafe(ws, payloadBuf, { binary: true, compress: false });
        }
        sendEof();
      } else if (options.interactive || !process.stdin.isTTY) {
        if (process.stdin.readableEnded) {
          sendEof();
        } else {
          attachedStdinListeners = true;
          process.stdin.on('data', onStdinData);
          process.stdin.on('end', onStdinEnd);
          process.stdin.on('close', onStdinEnd);
          process.stdin.resume();
          if (process.stdin.readableEnded) {
            sendEof();
          }
        }
      } else {
        sendEof();
      }
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

    const sigintHandler = () => {
      if (isTerminated) process.exit(130);
      isTerminated = true;
      forwardKillAndExit('SIGINT', 130);
    };
    const sigtermHandler = () => {
      isTerminated = true;
      forwardKillAndExit('SIGTERM', 143);
    };
    process.on('SIGINT', sigintHandler);
    process.on('SIGTERM', sigtermHandler);

    const cleanup = () => {
      process.removeListener('SIGINT', sigintHandler);
      process.removeListener('SIGTERM', sigtermHandler);
      if (execStartedFallbackTimer) {
        clearTimeout(execStartedFallbackTimer);
        execStartedFallbackTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (attachedStdinListeners) {
        process.stdin.removeListener('data', onStdinData);
        process.stdin.removeListener('end', onStdinEnd);
        process.stdin.removeListener('close', onStdinEnd);
        try { process.stdin.pause(); } catch {}
        attachedStdinListeners = false;
      }
    };

    const finish = (code: number) => {
      if (exitResolved) return;
      exitResolved = true;
      cleanup();
      try {
        if (ws && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN)) {
          ws.close(1000, 'Done');
        }
      } catch {}
      resolve(code);
    };

    const fail = (err: Error) => {
      if (exitResolved) return;
      exitResolved = true;
      cleanup();
      reject(err);
    };

    ws.on('pong', () => {
      lastActivityAt = Date.now();
    });

    ws.on('open', () => {
      isConnected = true;
      lastActivityAt = Date.now();
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;

      sendWsSafe(ws, JSON.stringify({
        type: 'exec_start',
        protocolVersion: PROTOCOL_VERSION,
        command: fullCommand,
        cwd: workdir,
        env,
        timeoutMs: timeoutMs || 0,
        tty: false,
        interactive: Boolean(options.interactive),
        cols,
        rows,
      }), { binary: false, compress: false });

      heartbeatTimer = setInterval(() => {
        if (!ws || (ws.readyState !== 1 && ws.readyState !== WebSocket.OPEN)) return;
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
        receivedServerOutput = true;
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
            if (json.type === 'exec_started') {
              execStarted = true;
              startInputPipeline(Boolean(json.capabilities?.stdinEof));
              return;
            }
            if (json.type === 'pong') {
              return;
            }
            if (json.type === 'exec_error') {
              if (json.error) {
                process.stderr.write(`[${hostId}] Execution error: ${json.error}\n`);
              }
              finish(typeof json.exitCode === 'number' ? json.exitCode : 1);
              return;
            }
            if (json.type === 'exec_exit') {
              const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
              const exitCode = json.exitCode !== undefined ? json.exitCode : 0;
              if (verbose) {
                if (exitCode === 0) {
                  process.stderr.write(`<<< [${hostId}] Command completed with code 0 (took ${durationSec}s)\n`);
                } else {
                  process.stderr.write(`<<< [${hostId}] Command failed with code ${exitCode} (took ${durationSec}s)\n`);
                }
              }
              finish(exitCode);
              return;
            }
          }
        } catch {}
      }

      receivedServerOutput = true;
      process.stdout.write(data);
    });

    ws.on('error', (err: any) => {
      if (exitResolved) return;
      const errMsg = err?.message || String(err);
      if (!hasExecutionStarted()) {
        fail(new StreamExecError(errMsg, true));
      } else {
        fail(new StreamExecError(`WebSocket stream error after execution started: ${errMsg}`, false));
      }
    });

    ws.on('unexpected-response', (req: any, res: any) => {
      const statusCode = res?.statusCode || 0;
      if (!isConnected && !exitResolved) {
        const allowFallback = statusCode !== 401 && statusCode !== 403 && statusCode !== 429;
        fail(new StreamExecError(`WebSocket upgrade failed with HTTP ${statusCode}`, allowFallback, statusCode));
      }
      try { res?.resume?.(); } catch {}
      try { req?.destroy?.(); } catch {}
      try { ws?.terminate?.(); } catch {}
    });

    ws.on('close', (code: number, reason: any) => {
      if (exitResolved) return;
      const reasonStr = reason ? reason.toString() : '';
      if (!isConnected) {
        fail(new StreamExecError(`WebSocket closed before connecting: code ${code}${reasonStr ? ` (${reasonStr})` : ''}`, true));
        return;
      }
      if (code === 1008) {
        if (reasonStr && !reasonStr.includes('Host is offline')) {
          process.stderr.write(`\n[${hostId}] Connection closed: ${reasonStr}\n`);
        }
        finish(1);
        return;
      }
      if (code === 1000 && hasExecutionStarted()) {
        finish(0);
        return;
      }
      if (!hasExecutionStarted()) {
        fail(new StreamExecError(`WebSocket closed before exec_started (${reasonStr || `code ${code}`})`, true));
        return;
      }
      fail(new StreamExecError(`WebSocket disconnected after exec_started (${reasonStr || `code ${code}`})`, false));
    });
  });
}

async function runHttpPollExec({
  server,
  key,
  targetHost,
  fullCommand,
  workdir,
  timeoutMs,
  envVars,
  stdinPayload,
  detach,
  jsonOutput,
  verbose,
  startTime,
  pollInterval,
}: {
  server: string;
  key: string;
  targetHost: string;
  fullCommand: string;
  workdir?: string;
  timeoutMs: number;
  envVars: Record<string, string>;
  stdinPayload?: string;
  detach: boolean;
  jsonOutput: boolean;
  verbose: boolean;
  startTime: number;
  pollInterval: number;
}): Promise<void> {
  const startRes = await makeRequest({
    serverUrl: server,
    endpoint: `/api/terminal/exec/${encodeURIComponent(targetHost)}`,
    method: 'POST',
    body: {
      command: fullCommand,
      cwd: workdir,
      timeoutMs,
      env: envVars,
      stdin: stdinPayload,
    },
    apiKey: key,
  });

  if (!startRes.data || !startRes.data.success) {
    console.error(`Error starting task on [${targetHost}]: ${startRes.data?.error || `HTTP ${startRes.status}`}`);
    process.exit(1);
  }

  const { taskId } = startRes.data;

  if (detach) {
    if (jsonOutput) {
      console.log(JSON.stringify(startRes.data, null, 2));
    } else {
      console.log(taskId);
      console.log(`Run 'gt task logs -f ${targetHost} ${taskId}' to follow logs.`);
    }
    process.exit(0);
  }

  let offset = 0;
  let isTerminated = false;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 30;

  process.on('SIGINT', async () => {
    if (isTerminated) process.exit(130);
    isTerminated = true;
    process.stderr.write(`\n[Interrupted] Terminating remote task [${taskId}]...\n`);
    try {
      await makeRequest({
        serverUrl: server,
        endpoint: `/api/terminal/exec/${encodeURIComponent(targetHost)}/${encodeURIComponent(taskId)}/kill`,
        method: 'POST',
        body: { signal: 'SIGTERM' },
        apiKey: key,
      });
    } catch {}
    process.exit(130);
  });

  const poll = async () => {
    try {
      const pollRes = await makeRequest({
        serverUrl: server,
        endpoint: `/api/terminal/exec/${encodeURIComponent(targetHost)}/${encodeURIComponent(taskId)}?offset=${offset}`,
        method: 'GET',
        apiKey: key,
      });

      if (pollRes.data && pollRes.data.success) {
        if (consecutiveErrors >= 3) {
          process.stderr.write(`\n[${targetHost}] Connection restored, continuing stream...\n`);
        }
        consecutiveErrors = 0;
        const t = pollRes.data;
        if (t.stdout) process.stdout.write(t.stdout);
        if (t.stderr) process.stderr.write(t.stderr);

        offset = t.outputOffset !== undefined ? t.outputOffset : (t.offset !== undefined ? t.offset : offset);

        if (t.status !== 'running') {
          const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
          const exitCode = t.exitCode !== null && t.exitCode !== undefined ? t.exitCode : (t.status === 'completed' ? 0 : 1);

          if (verbose) {
            if (exitCode === 0) {
              process.stderr.write(`<<< [${targetHost}] Command completed with code 0 (took ${durationSec}s)\n`);
            } else {
              process.stderr.write(`<<< [${targetHost}] Command failed with code ${exitCode} (${t.status}, took ${durationSec}s)\n`);
            }
          }
          process.exit(exitCode);
        }
      } else {
        consecutiveErrors++;
      }
    } catch (err) {
      consecutiveErrors++;
    }

    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      console.error(`\n<<< [${targetHost}] Connection lost after ${MAX_CONSECUTIVE_ERRORS} retries while streaming task [${taskId}]. Aborting.`);
      process.exit(1);
    } else if (consecutiveErrors === 3) {
      process.stderr.write(`\n[${targetHost}] Server temporarily unavailable, waiting for reconnection...\n`);
    }

    setTimeout(poll, pollInterval);
  };

  poll();
}

export async function runExecCommand({
  server,
  key,
  cmdArgs,
  jsonOutput = false,
}: {
  server: string;
  key: string;
  cmdArgs: string[];
  jsonOutput?: boolean;
}): Promise<void> {
  let parsed: ExecParsedArgs;
  try {
    parsed = parseExecArgs(cmdArgs);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
  const { host, fullCommand, commandParts, options } = parsed;
  const { detach, workdir, timeoutMs, verbose, pollInterval, env: envVars, interactive, tty } = options;

  if (!host || commandParts.length === 0) {
    console.error('Error: "gt exec" requires at least 2 arguments.');
    if (!host) {
      console.error('Missing target host.');
    } else {
      console.error('Missing command to execute.');
    }
    console.error('Usage: gt exec [OPTIONS] <host> <command...>');
    process.exit(1);
  }

  let resolvedHost: { id: string; name: string };
  try {
    resolvedHost = await resolveHost(server, key, host);
  } catch (err: any) {
    if (err?.message && err.message.startsWith('Ambiguous host identifier')) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    resolvedHost = { id: host, name: host };
  }
  const targetHost = resolvedHost.id;

  if (interactive && tty) {
    const exitCode = await runInteractiveExec({
      serverUrl: server,
      apiKey: key,
      hostId: targetHost,
      fullCommand,
      options,
    });
    process.exit(exitCode);
  }

  const readAllStdin = async (): Promise<string> => {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      process.stdin.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf-8'));
      });
      process.stdin.on('end', () => { resolve(Buffer.concat(chunks).toString('utf-8')); });
      process.stdin.on('error', () => { resolve(Buffer.concat(chunks).toString('utf-8')); });
      process.stdin.resume();
    });
  };

  let stdinPayload: string | undefined = undefined;
  const needsBufferedStdinBeforeRun = detach || options.mode === 'poll';
  if (interactive && !tty && needsBufferedStdinBeforeRun) {
    stdinPayload = await readAllStdin();
  }

  const startTime = Date.now();

  if (verbose) {
    process.stderr.write(`>>> [${targetHost}] $ ${fullCommand}\n`);
  }

  if (detach) {
    await runHttpPollExec({
      server,
      key,
      targetHost,
      fullCommand,
      workdir,
      timeoutMs,
      envVars,
      stdinPayload,
      detach: true,
      jsonOutput,
      verbose,
      startTime,
      pollInterval,
    });
    return;
  }

  if (options.mode === 'poll') {
    try {
      await runHttpPollExec({
        server,
        key,
        targetHost,
        fullCommand,
        workdir,
        timeoutMs,
        envVars,
        stdinPayload,
        detach: false,
        jsonOutput,
        verbose,
        startTime,
        pollInterval,
      });
    } catch (err: any) {
      console.error(`Failed to execute on [${targetHost}]: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  try {
    const exitCode = await runStreamExec({
      serverUrl: server,
      apiKey: key,
      hostId: targetHost,
      fullCommand,
      options,
      stdinPayload,
      startTime,
    });
    process.exit(exitCode);
  } catch (wsErr: any) {
    if (wsErr && wsErr.allowHttpFallback === false) {
      console.error(`Failed to execute on [${targetHost}]: ${wsErr.message}`);
      process.exit(1);
    }
    // If WebSocket connection fails before execution starts (e.g. HTTP-only test mock or non-upgradable proxy), fallback to HTTP polling
    try {
      if (interactive && !tty && stdinPayload === undefined && !process.stdin.readableEnded) {
        stdinPayload = await readAllStdin();
      }
      await runHttpPollExec({
        server,
        key,
        targetHost,
        fullCommand,
        workdir,
        timeoutMs,
        envVars,
        stdinPayload,
        detach: false,
        jsonOutput,
        verbose,
        startTime,
        pollInterval,
      });
    } catch (err: any) {
      console.error(`Failed to execute on [${targetHost}]: ${err.message}`);
      process.exit(1);
    }
  }
}

