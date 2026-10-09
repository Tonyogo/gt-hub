import { ConfigStore } from '../config/configStore';
import { makeRequest } from '../utils/terminalUI';

export async function handleAuthLogin({
  server,
  key,
  context,
  subArgs = [],
}: {
  server?: string;
  key?: string;
  context?: string;
  subArgs?: string[];
} = {}): Promise<void> {
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

  const effective = ConfigStore.getEffectiveConfig({ server: targetServer, key: targetKey, context });
  targetServer = targetServer || effective.server;
  targetKey = targetKey !== undefined ? targetKey : effective.key;
  const targetContext = context || effective.context || 'default';

  if (!targetKey) {
    console.error('Error: Missing secret key. Usage: gt auth login [server] [key]');
    process.exit(1);
  }

  targetServer = targetServer.replace(/\/+$/, '');

  try {
    let res = await makeRequest({
      serverUrl: targetServer,
      endpoint: '/api/auth/status',
      method: 'GET',
      apiKey: targetKey,
    });

    if (res.status === 404) {
      res = await makeRequest({
        serverUrl: targetServer,
        endpoint: '/api/terminal/hosts',
        method: 'GET',
        apiKey: targetKey,
      });
    }

    const isOk =
      res.status === 200 &&
      (res.data?.authenticated === true ||
       res.data?.authRequired === false ||
       res.data?.hosts !== undefined);

    if (isOk) {
      ConfigStore.setContext(targetContext, {
        server: targetServer,
        key: targetKey,
      });
      ConfigStore.useContext(targetContext);
      const config = ConfigStore.load();
      config.server = targetServer;
      config.key = targetKey;
      ConfigStore.save(config);
      console.log(`Successfully verified and logged in to ${targetServer}`);
      console.log(`Context "${targetContext}" is now active.`);
    } else {
      console.error(`Authentication failed: Invalid secret key for ${targetServer}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`Authentication failed: Failed to connect to ${targetServer}: ${err.message}`);
    process.exit(1);
  }
}

export async function handleAuthStatus({
  server,
  key,
  context,
}: {
  server?: string;
  key?: string;
  context?: string;
} = {}): Promise<void> {
  const effective = ConfigStore.getEffectiveConfig({ server, key, context });
  console.log(`Active Context : ${effective.context}`);
  console.log(`Target Hub     : ${effective.server}`);
  console.log(`Secret Key     : ${effective.key ? '******' : '<not set>'}`);

  try {
    let res = await makeRequest({
      serverUrl: effective.server,
      endpoint: '/api/auth/status',
      method: 'GET',
      apiKey: effective.key,
    });

    if (res.status === 404) {
      res = await makeRequest({
        serverUrl: effective.server,
        endpoint: '/api/terminal/hosts',
        method: 'GET',
        apiKey: effective.key,
      });
    }

    if (res.status === 200 && res.data?.authenticated !== false) {
      console.log(`Connection     : Connected (HTTP 200 OK)`);
    } else {
      console.log(`Connection     : Failed (HTTP ${res.status})`);
    }
  } catch (err: any) {
    console.log(`Connection     : Unreachable (${err.message})`);
  }
}

export function handleAuthLogout(all: boolean = false): void {
  if (all) {
    const contexts = ConfigStore.getContexts();
    for (const name of Object.keys(contexts)) {
      ConfigStore.setContext(name, { key: '' });
    }
    const config = ConfigStore.load();
    delete config.key;
    ConfigStore.save(config);
    console.log('Successfully logged out of all contexts.');
  } else {
    const current = ConfigStore.getCurrentContext();
    ConfigStore.setContext(current, { key: '' });
    const config = ConfigStore.load();
    delete config.key;
    ConfigStore.save(config);
    console.log(`Successfully logged out of context "${current}".`);
  }
}

export const handleLogin = handleAuthLogin;
export const handleLogout = handleAuthLogout;
