import path from 'path';
import os from 'os';
import fs from 'fs';
import { ConfigStore } from '../src/client/config/configStore';
import {
  handleConfigGetContexts,
  handleConfigCurrentContext,
  handleConfigUseContext,
  handleConfigSetContext,
  handleConfigDeleteContext,
} from '../src/client/commands/config';
import { handleAuthLogout } from '../src/client/commands/auth';

describe('gt config and gt auth commands', () => {
  let tmpDir: string;
  let logOutput: string[] = [];
  const originalLog = console.log;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `gt-cmd-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    process.env.GT_CONFIG_DIR = tmpDir;
    logOutput = [];
    console.log = (...args: any[]) => logOutput.push(args.join(' '));
  });

  afterEach(() => {
    console.log = originalLog;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('prints current context', () => {
    handleConfigCurrentContext();
    expect(logOutput.join('\n')).toContain('default');
  });

  it('creates and switches context using set-context and use-context', () => {
    handleConfigSetContext('prod', { server: 'https://hub.prod.com', key: 'my-secret' });
    handleConfigUseContext('prod');
    expect(ConfigStore.getCurrentContext()).toBe('prod');

    handleConfigGetContexts();
    const table = logOutput.join('\n');
    expect(table).toContain('*');
    expect(table).toContain('prod');
    expect(table).toContain('https://hub.prod.com');
  });

  it('clears credentials on auth logout', () => {
    ConfigStore.setContext('prod', { server: 'https://hub.prod.com', key: 'my-secret' });
    ConfigStore.useContext('prod');

    handleAuthLogout();
    expect(ConfigStore.getContexts()['prod'].key).toBe('');
  });
});
