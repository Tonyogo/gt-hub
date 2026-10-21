import { quoteShellArg, resolveHost, makeRequest } from '../utils/terminalUI';
import { runInteractiveExec, getWebSocketCtor } from '../interactive/interactiveExec';

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
  let mode: 'stream' | 'poll' = rawModeEnv === 'poll' || rawModeEnv === 'http' ? 'poll' : 'stream';
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
    } else if (a === '--poll' || a === '--http') {
      mode = 'poll';
    } else if (a === '--stream' || a === '--ws') {
      mode = 'stream';
    } else if (a === '--mode') {
      const nextArg = (args[++i] || '').toLowerCase();
      if (nextArg === 'poll' || nextArg === 'http') {
        mode = 'poll';
      } else if (nextArg === 'stream' || nextArg === 'ws') {
        mode = 'stream';
      } else {
        throw new Error(`Invalid execution mode: "${nextArg}". Expected "stream" or "poll".`);
      }
    } else if (a.startsWith('--mode=')) {
      const val = a.slice(7).toLowerCase();
      if (val === 'poll' || val === 'http') {
        mode = 'poll';
      } else if (val === 'stream' || val === 'ws') {
        mode = 'stream';
      } else {
        throw new Error(`Invalid execution mode: "${val}". Expected "stream" or "poll".`);
      }
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

    let ws: any;
    try {
      ws = new WebSocket(targetUrl, { headers });
    } catch (err) {
      return reject(err);
    }

    let isConnected = false;
    let isTerminated = false;
    let exitResolved = false;

    const sigintHandler = () => {
      if (isTerminated) process.exit(130);
      isTerminated = true;
      try {
        if (ws && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN)) {
          ws.close();
        }
      } catch {}
      process.exit(130);
    };
    process.on('SIGINT', sigintHandler);

    const cleanup = () => {
      process.removeListener('SIGINT', sigintHandler);
    };

    ws.on('open', () => {
      isConnected = true;
      const cols = process.stdout.columns || 80;
      const rows = process.stdout.rows || 24;

      ws.send(JSON.stringify({
        type: 'exec_start',
        command: fullCommand,
        cwd: workdir,
        env,
        timeoutMs: timeoutMs || 0,
        tty: false,
        interactive: false,
        cols,
        rows,
      }));

      if (stdinPayload) {
        ws.send(Buffer.from(stdinPayload, 'utf-8'));
        ws.send(Buffer.from([0x04]));
      } else if (!process.stdin.isTTY) {
        let eofSent = false;
        const sendEof = () => {
          if (!eofSent && (ws.readyState === 1 || ws.readyState === WebSocket.OPEN)) {
            eofSent = true;
            ws.send(Buffer.from([0x04]));
          }
        };

        if (process.stdin.readableEnded) {
          sendEof();
        } else {
          process.stdin.on('data', (chunk) => {
            if (ws.readyState === 1 || ws.readyState === WebSocket.OPEN) {
              ws.send(chunk);
            }
          });
          process.stdin.on('end', sendEof);
          process.stdin.on('close', sendEof);
          process.stdin.resume();
          if (process.stdin.readableEnded) {
            sendEof();
          }
        }
      }
    });

    ws.on('message', (data: any, isBinary: boolean) => {
      if (isBinary) {
        process.stdout.write(data);
        return;
      }

      const str = data.toString();
      if (str.includes('[Host Offline]')) {
        process.stderr.write(str);
        return;
      }

      try {
        const json = JSON.parse(str);
        if (json.type === 'exec_started') {
          return;
        }
        if (json.type === 'exec_exit') {
          exitResolved = true;
          cleanup();
          const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
          const exitCode = json.exitCode !== undefined ? json.exitCode : 0;
          if (verbose) {
            if (exitCode === 0) {
              process.stderr.write(`<<< [${hostId}] Command completed with code 0 (took ${durationSec}s)\n`);
            } else {
              process.stderr.write(`<<< [${hostId}] Command failed with code ${exitCode} (took ${durationSec}s)\n`);
            }
          }
          resolve(exitCode);
          return;
        }
      } catch {}

      process.stdout.write(data);
    });

    ws.on('error', (err: any) => {
      cleanup();
      if (!isConnected) {
        reject(err);
      } else {
        if (!exitResolved) {
          console.error(`\n[${hostId}] WebSocket stream error: ${err.message}`);
          resolve(1);
        }
      }
    });

    ws.on('unexpected-response', (_req: any, res: any) => {
      cleanup();
      if (!isConnected) {
        reject(new Error(`WebSocket upgrade failed with HTTP ${res.statusCode}`));
      }
    });

    ws.on('close', (code: number, reason: any) => {
      cleanup();
      if (!isConnected) {
        reject(new Error(`WebSocket closed before connecting: code ${code}`));
      } else if (!exitResolved) {
        if (code !== 1000 && code !== 1005) {
          const reasonStr = reason ? reason.toString() : '';
          if (code === 1001 || reasonStr.includes('Server shutting down')) {
            reject(new Error(`WebSocket closed by server (${reasonStr || `code ${code}`})`));
            return;
          }
          if (reasonStr && !reasonStr.includes('Host is offline')) {
            process.stderr.write(`\n[${hostId}] Connection closed: ${reasonStr}\n`);
          }
          resolve(1);
        } else {
          resolve(0);
        }
      }
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
  } catch (err) {
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

  let stdinPayload: string | undefined = undefined;
  if (interactive && !tty) {
    stdinPayload = await new Promise((resolve) => {
      let buf = '';
      process.stdin.setEncoding('utf-8');
      process.stdin.on('data', (chunk) => { buf += chunk; });
      process.stdin.on('end', () => { resolve(buf); });
      process.stdin.on('error', () => { resolve(buf); });
      process.stdin.resume();
    });
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
    // If WebSocket connection fails to initialize (e.g. HTTP-only test mock or non-upgradable proxy), fallback to HTTP polling
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
  }
}

