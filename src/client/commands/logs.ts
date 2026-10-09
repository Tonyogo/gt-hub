import { AgentDaemonManager } from '../../agent/daemon';
import { makeRequest, resolveHost, resolveTaskId } from '../utils/terminalUI';

export async function handleRemoteLogs({
  server,
  key,
  args = [],
  jsonOutput = false,
}: {
  server: string;
  key: string;
  args?: string[];
  jsonOutput?: boolean;
}): Promise<void> {
  let follow = false;
  let pollInterval = 500;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a === '--follow') {
      follow = true;
    } else if (a === '--poll-interval') {
      pollInterval = parseInt(args[++i], 10) || 500;
    } else if (a.startsWith('--poll-interval=')) {
      pollInterval = parseInt(a.slice(16), 10) || 500;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }

  if (positional.length < 1) {
    console.error('Error: Missing target host. Usage: gt logs [OPTIONS] <node> [taskId]');
    process.exit(125);
  }

  const hostInput = positional[0];
  let resolvedHost: { id: string; name: string };
  try {
    resolvedHost = await resolveHost(server, key, hostInput);
  } catch (err: any) {
    if (err.message && (err.message.includes('Ambiguous') || err.message.includes('No such host'))) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    resolvedHost = { id: hostInput, name: hostInput };
  }

  let taskId = positional[1];
  try {
    const taskListRes = await makeRequest({
      serverUrl: server,
      endpoint: `/api/terminal/exec/${encodeURIComponent(resolvedHost.id)}`,
      method: 'GET',
      apiKey: key,
    });
    if (taskListRes.data && taskListRes.data.success && Array.isArray(taskListRes.data.tasks)) {
      if (!taskId) {
        if (taskListRes.data.tasks.length === 0) {
          console.error(`No tasks found on node [${resolvedHost.id}].`);
          process.exit(1);
        }
        taskId = taskListRes.data.tasks[0].taskId;
      } else {
        taskId = resolveTaskId(taskListRes.data.tasks, taskId);
      }
    }
  } catch (err: any) {
    if (err.message && (err.message.includes('Ambiguous') || err.message.includes('No such task'))) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }

  if (!taskId) {
    console.error(`Error: No taskId specified and could not deduce latest task on node [${resolvedHost.id}].`);
    process.exit(1);
  }

  const hostId = resolvedHost.id;

  if (!follow) {
    try {
      const res = await makeRequest({
        serverUrl: server,
        endpoint: `/api/terminal/exec/${encodeURIComponent(hostId)}/${encodeURIComponent(taskId)}`,
        method: 'GET',
        apiKey: key,
      });

      if (jsonOutput) {
        console.log(JSON.stringify(res.data, null, 2));
        process.exit(0);
      }

      if (res.data && res.data.success) {
        const d = res.data;
        console.log(`Task:     ${d.taskId}`);
        console.log(`Host:     ${d.hostId}`);
        console.log(`Status:   ${d.status}`);
        console.log(`ExitCode: ${d.exitCode !== null && d.exitCode !== undefined ? d.exitCode : 'N/A'}`);
        const outputText = d.output !== undefined ? d.output : (d.stdout || '');
        if (outputText) {
          console.log('\n--- Output ---');
          process.stdout.write(outputText);
          if (!outputText.endsWith('\n')) console.log();
        }
        process.exit(0);
      } else {
        console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
        process.exit(1);
      }
    } catch (err: any) {
      console.error(`Failed to get logs for [${taskId}]: ${err.message}`);
      process.exit(1);
    }
  } else {
    process.on('SIGINT', () => {
      process.exit(130);
    });

    let offset = 0;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 30;

    const poll = async () => {
      try {
        const pollRes = await makeRequest({
          serverUrl: server,
          endpoint: `/api/terminal/exec/${encodeURIComponent(hostId)}/${encodeURIComponent(taskId)}?offset=${offset}`,
          method: 'GET',
          apiKey: key,
        });

        if (pollRes.data && pollRes.data.success) {
          if (consecutiveErrors >= 3) {
            process.stderr.write(`\n[${hostId}] Connection restored, continuing stream...\n`);
          }
          consecutiveErrors = 0;
          const t = pollRes.data;
          if (t.stdout) process.stdout.write(t.stdout);
          if (t.stderr) process.stderr.write(t.stderr);
          if (!t.stdout && !t.stderr && t.output) process.stdout.write(t.output);

          offset = t.outputOffset !== undefined ? t.outputOffset : (t.offset !== undefined ? t.offset : offset);

          if (t.status !== 'running') {
            const exitCode = t.exitCode !== null && t.exitCode !== undefined ? t.exitCode : (t.status === 'completed' ? 0 : 1);
            process.exit(exitCode);
          }
        } else {
          consecutiveErrors++;
        }
      } catch (err) {
        consecutiveErrors++;
      }

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(`\n<<< [${hostId}] Connection lost after ${MAX_CONSECUTIVE_ERRORS} retries while streaming task [${taskId}]. Aborting.`);
        process.exit(1);
      } else if (consecutiveErrors === 3) {
        process.stderr.write(`\n[${hostId}] Server temporarily unavailable, waiting for reconnection...\n`);
      }

      setTimeout(poll, pollInterval);
    };

    poll();
  }
}

export async function handleLogsDispatcher({
  server,
  key,
  args = [],
  jsonOutput = false,
}: {
  server: string;
  key: string;
  args?: string[];
  jsonOutput?: boolean;
}): Promise<void> {
  let lines = 50;
  let follow = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-f' || a === '--follow') {
      follow = true;
    } else if (a === '-n' || a === '--lines') {
      lines = parseInt(args[++i], 10) || 50;
    } else if (a.startsWith('-n=')) {
      lines = parseInt(a.slice(3), 10) || 50;
    } else if (a.startsWith('--lines=')) {
      lines = parseInt(a.slice(8), 10) || 50;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }

  if (positional.length >= 2) {
    if (!jsonOutput) {
      process.stderr.write(`[Notice] Redirecting to 'gt task logs ${positional.join(' ')}'...\n`);
    }
    await handleRemoteLogs({ server, key, args, jsonOutput });
    return;
  }

  const targetName = positional[0];
  const resolved = AgentDaemonManager.resolveTarget(targetName, 'logs');
  if (resolved.agent) {
    await AgentDaemonManager.getLogs(resolved.agent.name, lines, follow);
    process.exit(0);
  }

  if (targetName) {
    await handleRemoteLogs({ server, key, args, jsonOutput });
    return;
  }

  if (resolved.error) {
    console.error(resolved.error);
    process.exit(1);
  }

  console.log('No running agent daemons found.');
  process.exit(0);
}
