import { makeRequest, formatTemplate } from '../utils/terminalUI';
import { formatRelativeTime } from '../../shared/utils/timeHelpers';
import { AgentDaemonManager } from '../../agent/daemon';

export async function handleRemotePs({
  server,
  key,
  args = [],
  jsonOutput = false,
  formatTemplateStr = null,
}: {
  server: string;
  key: string;
  args?: string[];
  jsonOutput?: boolean;
  formatTemplateStr?: string | null;
}): Promise<void> {
  let showAll = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-a' || a === '--all') {
      showAll = true;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a === '--format') {
      formatTemplateStr = args[++i];
    } else if (a.startsWith('--format=')) {
      formatTemplateStr = a.slice(9);
    }
  }

  try {
    const res = await makeRequest({
      serverUrl: server,
      endpoint: '/api/terminal/hosts',
      method: 'GET',
      apiKey: key,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(res.data, null, 2));
      process.exit(0);
    }

    if (res.data && Array.isArray(res.data.hosts)) {
      let hosts: any[] = res.data.hosts;
      if (!showAll) {
        hosts = hosts.filter(h => h.status === 'online');
      }

      if (formatTemplateStr) {
        const formatted = formatTemplate(formatTemplateStr, hosts);
        if (formatted) console.log(formatted);
        process.exit(0);
      }

      if (hosts.length === 0) {
        console.log(showAll ? 'No terminal agent hosts recorded.' : 'No online terminal agent hosts found. (Use -a to show offline)');
        if (!jsonOutput && !formatTemplateStr) {
          const runningAgents = AgentDaemonManager.getAllAgents().filter(a => a.running);
          if (runningAgents.length > 0) {
            console.log(`\n(Tip: ${runningAgents.length} local agent daemon(s) active. Run 'gt ps -l' to view)`);
          }
        }
        process.exit(0);
      }

      console.log(
        'NODE ID'.padEnd(20) +
        'NAME'.padEnd(25) +
        'STATUS'.padEnd(12) +
        'VERSION'.padEnd(12) +
        'PLATFORM'.padEnd(12) +
        'IP'.padEnd(18) +
        'LAST SEEN'
      );
      console.log('-'.repeat(107));

      for (const h of hosts) {
        const statusStr = h.status === 'online' ? 'online' : 'offline';
        const verStr = h.version || '-';
        console.log(
          (h.id || '').padEnd(20) +
          (h.name || h.hostname || '').padEnd(25) +
          statusStr.padEnd(12) +
          verStr.padEnd(12) +
          (h.platform || '').padEnd(12) +
          (h.ip || '').padEnd(18) +
          formatRelativeTime(h.lastSeen)
        );
      }

      if (!jsonOutput && !formatTemplateStr) {
        const runningAgents = AgentDaemonManager.getAllAgents().filter(a => a.running);
        if (runningAgents.length > 0) {
          console.log(`\n(Tip: ${runningAgents.length} local agent daemon(s) active. Run 'gt ps -l' to view)`);
        }
      }
      process.exit(0);
    } else {
      console.error(`Error: ${res.data?.error || `HTTP ${res.status}`}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`Failed to query hosts: ${err.message}`);
    process.exit(1);
  }
}

export async function handleRemotePrune({
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
  if (args.includes('--json')) jsonOutput = true;
  try {
    const res = await makeRequest({
      serverUrl: server,
      endpoint: '/api/terminal/hosts/offline',
      method: 'DELETE',
      apiKey: key,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(res.data, null, 2));
      process.exit(0);
    }

    if (res.status === 200 && res.data && res.data.success) {
      console.log(`Pruned ${res.data.prunedCount ?? res.data.removed ?? 0} offline host(s).`);
      process.exit(0);
    } else {
      console.error(`Failed to prune offline hosts: ${res.data?.error || `HTTP ${res.status}`}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`Failed to prune offline hosts: ${err.message}`);
    process.exit(1);
  }
}
