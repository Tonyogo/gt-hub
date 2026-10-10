import { getVersionInfo, VersionInfo } from '../../shared/version';
import { makeRequest } from '../utils/terminalUI';

export async function handleVersionCommand({
  server,
  key,
  clientOnly = false,
  jsonOutput = false,
}: {
  server: string;
  key: string;
  clientOnly?: boolean;
  jsonOutput?: boolean;
}): Promise<void> {
  const clientInfo = getVersionInfo();

  let serverInfo: (VersionInfo & { url: string }) | null = null;
  let serverError: string | null = null;

  if (!clientOnly) {
    try {
      const res = await makeRequest({
        serverUrl: server,
        endpoint: '/api/terminal/version',
        method: 'GET',
        apiKey: key,
      });

      if (res.status === 200 && res.data && res.data.version) {
        serverInfo = {
          url: server,
          version: res.data.version,
          gitCommit: res.data.gitCommit || 'unknown',
          buildTime: res.data.buildTime || 'unknown',
          platform: res.data.platform || 'unknown',
        };
      } else {
        serverError = res.data?.error || `HTTP ${res.status}`;
      }
    } catch (err: any) {
      serverError = err.message || 'Unable to connect to Hub';
    }
  }

  if (jsonOutput) {
    const output: Record<string, any> = { client: clientInfo };
    if (!clientOnly) {
      if (serverInfo) {
        output.server = serverInfo;
      } else {
        output.server = {
          url: server,
          error: serverError,
        };
      }
    }
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  // Formatted human-readable output
  console.log('Client:');
  console.log(`  Version:    ${clientInfo.version}`);
  console.log(`  Git Commit: ${clientInfo.gitCommit}`);
  console.log(`  Build Time: ${clientInfo.buildTime}`);
  console.log(`  OS/Arch:    ${clientInfo.platform}`);

  if (!clientOnly) {
    console.log('');
    console.log(`Server (${server}):`);
    if (serverInfo) {
      console.log(`  Version:    ${serverInfo.version}`);
      console.log(`  Git Commit: ${serverInfo.gitCommit}`);
      console.log(`  Build Time: ${serverInfo.buildTime}`);
      console.log(`  OS/Arch:    ${serverInfo.platform}`);
    } else {
      console.log(`  Error:      ${serverError}`);
    }
  }

  process.exit(0);
}
