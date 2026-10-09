import { makeRequest, resolveHost, resolveTaskId } from '../utils/terminalUI';
import { ConfigStore } from '../config/configStore';

export async function handleRemoteKill({
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
  let signal = 'SIGTERM';
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--signal') {
      signal = args[++i];
    } else if (a.startsWith('--signal=')) {
      signal = a.slice(9);
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (!a.startsWith('-')) {
      positional.push(a);
    }
  }

  if (positional.length < 2) {
    console.error('Error: Missing arguments. Usage: gt kill [--signal <SIG>] <node> <taskId>');
    process.exit(125);
  }

  const [hostInput, taskInput] = positional;
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

  let taskId = taskInput;
  try {
    const taskListRes = await makeRequest({
      serverUrl: server,
      endpoint: `/api/terminal/exec/${encodeURIComponent(resolvedHost.id)}`,
      method: 'GET',
      apiKey: key,
    });
    if (taskListRes.data && taskListRes.data.success && Array.isArray(taskListRes.data.tasks)) {
      taskId = resolveTaskId(taskListRes.data.tasks, taskInput);
    }
  } catch (err: any) {
    if (err.message && (err.message.includes('Ambiguous') || err.message.includes('No such task'))) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }

  const hostId = resolvedHost.id;

  try {
    const res = await makeRequest({
      serverUrl: server,
      endpoint: `/api/terminal/exec/${encodeURIComponent(hostId)}/${encodeURIComponent(taskId)}/kill`,
      method: 'POST',
      body: { signal },
      apiKey: key,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(res.data, null, 2));
      process.exit(0);
    }

    if (res.data && res.data.success) {
      console.log(`Kill signal sent to task [${taskId}] on host [${hostId}].`);
      process.exit(0);
    } else {
      console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`Failed to kill task [${taskId}]: ${err.message}`);
    process.exit(1);
  }
}

export function handleConfig({
  cmdArgs = [],
  server,
  key,
}: {
  cmdArgs?: string[];
  server: string;
  key: string;
}): void {
  const subCmd = (cmdArgs[0] || 'list').toLowerCase();
  if (subCmd === 'list') {
    const stored = ConfigStore.load();
    const mask = (str?: string) => {
      if (!str) return '';
      if (str.length <= 3) return '***';
      return str.slice(0, 3) + '***';
    };
    const serverVal = stored.server !== undefined ? stored.server : server;
    const keyVal = stored.key !== undefined ? mask(stored.key) : '';
    console.log(`server = "${serverVal}"`);
    console.log(`key    = "${keyVal}"`);
    for (const [k, v] of Object.entries(stored)) {
      if (k !== 'server' && k !== 'key') {
        console.log(`${k.padEnd(6)} = "${v}"`);
      }
    }
    process.exit(0);
  } else if (subCmd === 'get') {
    const k = cmdArgs[1];
    if (!k) {
      console.error('Error: Missing key. Usage: gt config get <key>');
      process.exit(1);
    }
    const val = ConfigStore.get(k);
    if (val !== undefined && val !== null) {
      console.log(val);
    } else {
      console.log('');
    }
    process.exit(0);
  } else if (subCmd === 'set') {
    const k = cmdArgs[1];
    const v = cmdArgs[2];
    if (!k || v === undefined) {
      console.error('Error: Missing arguments. Usage: gt config set <key> <value>');
      process.exit(1);
    }
    ConfigStore.set(k, v);
    console.log(`Set ${k} = "${v}"`);
    process.exit(0);
  } else {
    console.error(`Error: Unknown config command: ${subCmd}`);
    console.error('Usage: gt config <list|get|set> [key] [val]');
    process.exit(1);
  }
}
