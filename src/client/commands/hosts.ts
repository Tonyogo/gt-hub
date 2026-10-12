import { makeRequest, formatTemplate } from '../utils/terminalUI';
import { formatRelativeTime } from '../../shared/utils/timeHelpers';
import { AgentDaemonManager } from '../../agent/daemon';
import { ConfigStore } from '../config/configStore';

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
        process.exit(0);
      }

      let localMachineId = '';
      try {
        localMachineId = ConfigStore.getMachineId();
      } catch {}

      let localStatus: any = null;
      try {
        localStatus = AgentDaemonManager.getStatus();
      } catch {}

      const headers = ['NODE ID', 'NAME', 'STATUS', 'VERSION', 'PLATFORM', 'IP', 'LAST SEEN'];
      const minColWidths = [18, 20, 10, 10, 10, 16, 10];

      const rows = hosts.map(h => {
        const isLocal = !!(
          (localMachineId && h.machineId && h.machineId === localMachineId) ||
          (localMachineId && h.id && h.id === localMachineId) ||
          (localStatus && localStatus.running && (
            (localStatus.id && h.id === localStatus.id) ||
            (localStatus.name && (h.name === localStatus.name || h.hostname === localStatus.name))
          ))
        );
        const baseName = h.name || h.hostname || '';
        const nameStr = isLocal && !baseName.endsWith('(local)') ? `${baseName} (local)` : baseName;
        const statusStr = h.status === 'online' ? 'online' : 'offline';
        const verStr = h.version || '-';
        const lastSeenStr = formatRelativeTime(h.lastSeen);

        return [
          h.id || '',
          nameStr,
          statusStr,
          verStr,
          h.platform || '',
          h.ip || '',
          lastSeenStr,
        ];
      });

      const colWidths = headers.map((header, colIdx) => {
        let max = Math.max(header.length, minColWidths[colIdx] || 0);
        for (const row of rows) {
          const len = (row[colIdx] || '').length;
          if (len > max) max = len;
        }
        return max;
      });

      const headerLine = headers.map((h, i) => {
        return i === headers.length - 1 ? h : h.padEnd(colWidths[i] + 3);
      }).join('');

      console.log(headerLine);
      console.log('-'.repeat(headerLine.length));

      for (const row of rows) {
        const line = row.map((cell, i) => {
          return i === row.length - 1 ? cell : cell.padEnd(colWidths[i] + 3);
        }).join('');
        console.log(line);
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
