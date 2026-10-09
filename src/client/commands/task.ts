import { handleRemoteKill } from './manage';
import { handleRemoteLogs } from './logs';
import { makeRequest, resolveHost, formatTemplate } from '../utils/terminalUI';

export async function handleTaskLs({
  server,
  key,
  node,
  json,
  format,
}: {
  server: string;
  key: string;
  node: string;
  json?: boolean;
  format?: string;
}): Promise<void> {
  let resolvedHost: { id: string; name: string };
  try {
    resolvedHost = await resolveHost(server, key, node);
  } catch (err: any) {
    if (err.message && (err.message.includes('Ambiguous') || err.message.includes('No such host'))) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    resolvedHost = { id: node, name: node };
  }

  try {
    const res = await makeRequest({
      serverUrl: server,
      endpoint: `/api/terminal/exec/${encodeURIComponent(resolvedHost.id)}`,
      method: 'GET',
      apiKey: key,
    });

    if (json) {
      console.log(JSON.stringify(res.data, null, 2));
      process.exit(0);
    }

    if (res.data && res.data.success && Array.isArray(res.data.tasks)) {
      const tasks: any[] = res.data.tasks;
      if (format) {
        const formatted = formatTemplate(format, tasks);
        if (formatted) console.log(formatted);
        process.exit(0);
      }

      if (tasks.length === 0) {
        console.log(`No recent tasks recorded on [${resolvedHost.id}].`);
        process.exit(0);
      }

      console.log(
        'TASK ID'.padEnd(26) +
        'STATUS'.padEnd(12) +
        'EXIT'.padEnd(8) +
        'START TIME'.padEnd(14) +
        'COMMAND'
      );
      console.log('-'.repeat(80));

      for (const t of tasks) {
        const timeStr = new Date(t.startTime).toLocaleTimeString();
        const exitStr = t.exitCode !== null && t.exitCode !== undefined ? String(t.exitCode) : '-';
        console.log(
          t.taskId.padEnd(26) +
          t.status.padEnd(12) +
          exitStr.padEnd(8) +
          timeStr.padEnd(14) +
          t.command
        );
      }
      process.exit(0);
    } else {
      console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`Failed to list tasks on [${resolvedHost.id}]: ${err.message}`);
    process.exit(1);
  }
}

export async function handleTaskLogs({
  server,
  key,
  node,
  taskId,
  follow,
  json,
}: {
  server: string;
  key: string;
  node: string;
  taskId?: string;
  follow?: boolean;
  json?: boolean;
}): Promise<void> {
  const args = [node];
  if (taskId) args.push(taskId);
  if (follow) args.push('-f');
  await handleRemoteLogs({
    server,
    key,
    args,
    jsonOutput: !!json,
  });
}

export async function handleTaskKill({
  server,
  key,
  node,
  taskId,
  signal,
  json,
}: {
  server: string;
  key: string;
  node: string;
  taskId: string;
  signal?: string;
  json?: boolean;
}): Promise<void> {
  const args = [node, taskId];
  if (signal) args.push(`--signal=${signal}`);
  await handleRemoteKill({
    server,
    key,
    args,
    jsonOutput: !!json,
  });
}
