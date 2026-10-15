import { makeRequest, resolveHost, formatTemplate } from '../utils/terminalUI';
import { isValidCronExpression } from '../../shared/utils/cronParser';
import { CronJobSummary } from '../../shared/types/cron';

function formatFutureTime(timestamp?: number | null): string {
  if (!timestamp) return '-';
  const diff = timestamp - Date.now();
  if (diff <= 0) return 'Due now';
  if (diff < 60000) return `in ${Math.floor(diff / 1000)}s`;
  if (diff < 3600000) return `in ${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `in ${Math.floor(diff / 3600000)}h`;
  return `in ${Math.floor(diff / 86400000)}d`;
}

function formatDuration(ms?: number | null): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export async function handleCronLs({
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
      endpoint: `/api/terminal/cron/${encodeURIComponent(resolvedHost.id)}`,
      method: 'GET',
      apiKey: key,
    });

    if (!res.data || !res.data.success) {
      console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
      process.exit(1);
    }

    const jobs: CronJobSummary[] = res.data.data || [];

    if (json) {
      console.log(JSON.stringify(jobs, null, 2));
      process.exit(0);
    }

    if (format) {
      const formatted = formatTemplate(format, jobs);
      if (formatted) console.log(formatted);
      process.exit(0);
    }

    if (jobs.length === 0) {
      console.log(`No cron jobs configured on [${resolvedHost.id}].`);
      process.exit(0);
    }

    const cronColWidth = Math.max(
      16,
      ...jobs.map((j) => j.cron.length)
    );

    console.log(
      'ID'.padEnd(16) +
      'NAME'.padEnd(20) +
      'CRON'.padEnd(cronColWidth + 2) +
      'STATUS'.padEnd(10) +
      'NEXT RUN'.padEnd(18) +
      'LAST STATUS'.padEnd(14) +
      'LAST DURATION'
    );
    console.log('-'.repeat(80 + cronColWidth + 2));

    for (const j of jobs) {
      const nextStr = formatFutureTime(j.nextRunTime);
      const lastStatus = j.lastExecution ? j.lastExecution.status : '-';
      const lastDuration = j.lastExecution ? formatDuration(j.lastExecution.durationMs) : '-';
      const cronStr = j.cron;

      console.log(
        j.id.padEnd(16) +
        j.name.padEnd(20) +
        cronStr.padEnd(cronColWidth + 2) +
        j.status.padEnd(10) +
        nextStr.padEnd(18) +
        lastStatus.padEnd(14) +
        lastDuration
      );
    }
    process.exit(0);
  } catch (err: any) {
    console.error(`Failed to list cron jobs on [${resolvedHost.id}]: ${err.message}`);
    process.exit(1);
  }
}

export async function handleCronAdd({
  server,
  key,
  node,
  name,
  cron,
  cmd,
  script,
  args,
  cwd,
  timeout,
  concurrency,
  paused,
}: {
  server: string;
  key: string;
  node: string;
  name?: string;
  cron?: string;
  cmd?: string;
  script?: string;
  args?: string | string[];
  cwd?: string;
  timeout?: number | string;
  concurrency?: string;
  paused?: boolean;
}): Promise<void> {
  if (!name || !name.trim()) {
    console.error('Error: Job name is required (--name <name>)');
    process.exit(1);
  }
  if (!cron || !cron.trim()) {
    console.error('Error: Cron expression is required (--cron "<expression>")');
    process.exit(1);
  }
  if (!isValidCronExpression(cron)) {
    console.error(`Error: Invalid cron expression: "${cron}". Must be standard 5-part cron.`);
    process.exit(1);
  }
  if (!cmd && !script) {
    console.error('Error: Either --cmd "<command>" or --script "<scriptName>" must be specified.');
    process.exit(1);
  }

  let resolvedHost: { id: string; name: string };
  try {
    resolvedHost = await resolveHost(server, key, node);
  } catch (err: any) {
    resolvedHost = { id: node, name: node };
  }

  let parsedArgs: string[] = [];
  if (Array.isArray(args)) {
    parsedArgs = args;
  } else if (typeof args === 'string' && args.trim()) {
    parsedArgs = args.split(/\s+/);
  }

  const payload: any = {
    name: name.trim(),
    cron: cron.trim(),
    source: script ? 'hub' : 'command',
    command: cmd?.trim(),
    scriptName: script?.trim(),
    scriptArgs: parsedArgs,
    cwd: cwd?.trim(),
    timeoutMs: timeout ? parseInt(String(timeout), 10) : undefined,
    concurrency: concurrency === 'allow' ? 'allow' : 'forbid',
    status: paused ? 'paused' : 'active',
  };

  try {
    const res = await makeRequest({
      serverUrl: server,
      endpoint: `/api/terminal/cron/${encodeURIComponent(resolvedHost.id)}`,
      method: 'POST',
      body: payload,
      apiKey: key,
    });

    if (!res.data || !res.data.success) {
      console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
      process.exit(1);
    }

    const created = res.data.data;
    console.log(`✓ Cron job "${created.name}" (${created.id}) created successfully on node [${resolvedHost.id}].`);
    process.exit(0);
  } catch (err: any) {
    console.error(`Failed to create cron job on [${resolvedHost.id}]: ${err.message}`);
    process.exit(1);
  }
}

export async function handleCronRm({
  server,
  key,
  node,
  jobId,
}: {
  server: string;
  key: string;
  node: string;
  jobId: string;
}): Promise<void> {
  if (!jobId || !jobId.trim()) {
    console.error('Error: Job ID or name is required.');
    process.exit(1);
  }

  let resolvedHost: { id: string; name: string };
  try {
    resolvedHost = await resolveHost(server, key, node);
  } catch (err: any) {
    resolvedHost = { id: node, name: node };
  }

  try {
    const res = await makeRequest({
      serverUrl: server,
      endpoint: `/api/terminal/cron/${encodeURIComponent(resolvedHost.id)}/${encodeURIComponent(jobId.trim())}`,
      method: 'DELETE',
      apiKey: key,
    });

    if (!res.data || !res.data.success) {
      console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
      process.exit(1);
    }

    console.log(`✓ Cron job "${jobId}" removed from node [${resolvedHost.id}].`);
    process.exit(0);
  } catch (err: any) {
    console.error(`Failed to remove cron job on [${resolvedHost.id}]: ${err.message}`);
    process.exit(1);
  }
}

export async function handleCronPause({
  server,
  key,
  node,
  jobId,
}: {
  server: string;
  key: string;
  node: string;
  jobId: string;
}): Promise<void> {
  if (!jobId || !jobId.trim()) {
    console.error('Error: Job ID or name is required.');
    process.exit(1);
  }

  let resolvedHost: { id: string; name: string };
  try {
    resolvedHost = await resolveHost(server, key, node);
  } catch (err: any) {
    resolvedHost = { id: node, name: node };
  }

  try {
    const res = await makeRequest({
      serverUrl: server,
      endpoint: `/api/terminal/cron/${encodeURIComponent(resolvedHost.id)}/${encodeURIComponent(jobId.trim())}`,
      method: 'PATCH',
      body: { status: 'paused' },
      apiKey: key,
    });

    if (!res.data || !res.data.success) {
      console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
      process.exit(1);
    }

    console.log(`✓ Cron job "${jobId}" paused on node [${resolvedHost.id}].`);
    process.exit(0);
  } catch (err: any) {
    console.error(`Failed to pause cron job on [${resolvedHost.id}]: ${err.message}`);
    process.exit(1);
  }
}

export async function handleCronResume({
  server,
  key,
  node,
  jobId,
}: {
  server: string;
  key: string;
  node: string;
  jobId: string;
}): Promise<void> {
  if (!jobId || !jobId.trim()) {
    console.error('Error: Job ID or name is required.');
    process.exit(1);
  }

  let resolvedHost: { id: string; name: string };
  try {
    resolvedHost = await resolveHost(server, key, node);
  } catch (err: any) {
    resolvedHost = { id: node, name: node };
  }

  try {
    const res = await makeRequest({
      serverUrl: server,
      endpoint: `/api/terminal/cron/${encodeURIComponent(resolvedHost.id)}/${encodeURIComponent(jobId.trim())}`,
      method: 'PATCH',
      body: { status: 'active' },
      apiKey: key,
    });

    if (!res.data || !res.data.success) {
      console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
      process.exit(1);
    }

    console.log(`✓ Cron job "${jobId}" resumed on node [${resolvedHost.id}].`);
    process.exit(0);
  } catch (err: any) {
    console.error(`Failed to resume cron job on [${resolvedHost.id}]: ${err.message}`);
    process.exit(1);
  }
}

export async function handleCronRun({
  server,
  key,
  node,
  jobId,
}: {
  server: string;
  key: string;
  node: string;
  jobId: string;
}): Promise<void> {
  if (!jobId || !jobId.trim()) {
    console.error('Error: Job ID or name is required.');
    process.exit(1);
  }

  let resolvedHost: { id: string; name: string };
  try {
    resolvedHost = await resolveHost(server, key, node);
  } catch (err: any) {
    resolvedHost = { id: node, name: node };
  }

  try {
    const res = await makeRequest({
      serverUrl: server,
      endpoint: `/api/terminal/cron/${encodeURIComponent(resolvedHost.id)}/${encodeURIComponent(jobId.trim())}/run`,
      method: 'POST',
      apiKey: key,
    });

    if (!res.data || !res.data.success) {
      console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
      process.exit(1);
    }

    console.log(`✓ Triggered execution for job "${jobId}" on node [${resolvedHost.id}].`);
    process.exit(0);
  } catch (err: any) {
    console.error(`Failed to trigger cron job on [${resolvedHost.id}]: ${err.message}`);
    process.exit(1);
  }
}

export async function handleCronLogs({
  server,
  key,
  node,
  jobId,
  tail,
  follow,
  pollInterval = 500,
}: {
  server: string;
  key: string;
  node: string;
  jobId: string;
  tail?: number;
  follow?: boolean;
  pollInterval?: number;
}): Promise<void> {
  if (!jobId || !jobId.trim()) {
    console.error('Error: Job ID or name is required.');
    process.exit(1);
  }

  let resolvedHost: { id: string; name: string };
  try {
    resolvedHost = await resolveHost(server, key, node);
  } catch (err: any) {
    resolvedHost = { id: node, name: node };
  }

  let currentOffset = 0;

  const fetchLogs = async () => {
    try {
      const res = await makeRequest({
        serverUrl: server,
        endpoint: `/api/terminal/cron/${encodeURIComponent(resolvedHost.id)}/${encodeURIComponent(jobId.trim())}/logs?offset=${currentOffset}`,
        method: 'GET',
        apiKey: key,
      });

      if (!res.data || !res.data.success) {
        return { running: false, error: res.data?.error || `HTTP ${res.status}` };
      }

      const data = (res.data && res.data.data) ? res.data.data : res.data;
      const text = data?.output || data?.stdout || '';
      if (text) {
        process.stdout.write(text);
      }
      currentOffset = data?.offset !== undefined ? data.offset : (data?.outputOffset !== undefined ? data.outputOffset : (currentOffset + Buffer.byteLength(text)));
      const isRunning = data?.status === 'running';
      return { running: isRunning, error: null };
    } catch (err: any) {
      return { running: false, error: err.message };
    }
  };

  const initial = await fetchLogs();
  if (initial.error) {
    console.error(`Failed to get logs for job "${jobId}" on [${resolvedHost.id}]: ${initial.error}`);
    process.exit(1);
  }

  if (!follow) {
    process.exit(0);
  }

  const timer = setInterval(async () => {
    const res = await fetchLogs();
    if (!res.running) {
      clearInterval(timer);
      process.exit(0);
    }
  }, Math.max(100, pollInterval));

  process.on('SIGINT', () => {
    clearInterval(timer);
    process.exit(0);
  });
}
