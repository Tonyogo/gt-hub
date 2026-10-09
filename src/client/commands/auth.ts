import { ConfigStore } from '../config/configStore';
import { makeRequest } from '../utils/terminalUI';

export async function handleLogin({
  server,
  key,
  subArgs = [],
}: {
  server: string;
  key: string;
  subArgs?: string[];
}): Promise<void> {
  let targetServer = server;
  let targetKey = key;

  if (subArgs.length >= 2) {
    targetServer = subArgs[0];
    targetKey = subArgs[1];
  } else if (subArgs.length === 1) {
    if (subArgs[0].startsWith('http://') || subArgs[0].startsWith('https://')) {
      targetServer = subArgs[0];
    } else {
      targetKey = subArgs[0];
    }
  }

  if (!targetKey) {
    console.error('Error: Missing secret key. Usage: gt login [server] [key]');
    process.exit(1);
  }

  targetServer = targetServer.replace(/\/+$/, '');

  try {
    const res = await makeRequest({
      serverUrl: targetServer,
      endpoint: '/api/terminal/hosts',
      method: 'GET',
      apiKey: targetKey,
    });

    if (res.status === 200) {
      const config = ConfigStore.load();
      config.server = targetServer;
      config.key = targetKey;
      ConfigStore.save(config);
      console.log(`Successfully verified and logged in to ${targetServer}`);
      process.exit(0);
    } else {
      console.error(`Authentication failed: HTTP ${res.status} ${res.data?.error || 'Unauthorized'}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`Authentication failed: ${err.message}`);
    process.exit(1);
  }
}

export function handleLogout(): void {
  const config = ConfigStore.load();
  delete config.key;
  ConfigStore.save(config);
  console.log('Successfully logged out.');
  process.exit(0);
}
