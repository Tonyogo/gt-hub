import { ConfigStore } from '../config/configStore';

export function handleConfigGetContexts(): void {
  const current = ConfigStore.getCurrentContext();
  const contexts = ConfigStore.getContexts();

  console.log(
    'CURRENT'.padEnd(10) +
    'NAME'.padEnd(20) +
    'SERVER'.padEnd(35) +
    'KEY'
  );
  console.log('-'.repeat(75));

  for (const [name, cfg] of Object.entries(contexts)) {
    const isCurrent = name === current ? '*' : '';
    const maskedKey = cfg.key ? '******' : '<not set>';
    console.log(
      isCurrent.padEnd(10) +
      name.padEnd(20) +
      cfg.server.padEnd(35) +
      maskedKey
    );
  }
}

export function handleConfigCurrentContext(): void {
  console.log(ConfigStore.getCurrentContext());
}

export function handleConfigUseContext(name: string): void {
  try {
    ConfigStore.useContext(name);
    console.log(`Switched to context "${name}".`);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

export function handleConfigSetContext(name: string, opts: { server?: string; key?: string }): void {
  ConfigStore.setContext(name, {
    server: opts.server,
    key: opts.key,
  });
  console.log(`Context "${name}" updated.`);
}

export function handleConfigDeleteContext(name: string): void {
  try {
    const res = ConfigStore.deleteContext(name);
    if (res.resetDefault) {
      console.log(`Reset context "default" to default settings.`);
    } else {
      console.log(`Deleted context "${name}".`);
    }
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

export function handleConfigView(raw: boolean = false): void {
  const data = { ...ConfigStore.load() };
  if (!raw && data.contexts) {
    const sanitizedContexts: Record<string, any> = {};
    for (const [k, v] of Object.entries(data.contexts)) {
      sanitizedContexts[k] = {
        server: v.server,
        key: v.key ? '******' : '',
      };
    }
    data.contexts = sanitizedContexts;
  }
  console.log(JSON.stringify(data, null, 2));
}

export function handleConfigGet(key: string): void {
  if (!key) {
    console.error('Error: Missing key. Usage: gt config get <key>');
    process.exit(1);
  }
  const val = ConfigStore.get(key);
  if (val !== undefined && val !== null) {
    console.log(val);
  } else {
    console.log('');
  }
}

export function handleConfigSet(key: string, val: any): void {
  if (!key || val === undefined) {
    console.error('Error: Missing arguments. Usage: gt config set <key> <value>');
    process.exit(1);
  }
  ConfigStore.set(key, val);
  console.log(`Set ${key} = "${val}"`);
}

export function handleConfigList(server?: string): void {
  const stored = ConfigStore.load();
  const mask = (str?: string) => {
    if (!str) return '';
    if (str.length <= 3) return '***';
    return str.slice(0, 3) + '***';
  };
  const serverVal = stored.server !== undefined ? stored.server : (server || '');
  const keyVal = stored.key !== undefined ? mask(stored.key) : '';
  console.log(`server = "${serverVal}"`);
  console.log(`key    = "${keyVal}"`);
  for (const [k, v] of Object.entries(stored)) {
    if (k !== 'server' && k !== 'key' && k !== 'contexts' && k !== 'currentContext' && k !== 'machineId') {
      console.log(`${k.padEnd(6)} = "${v}"`);
    }
  }
}
