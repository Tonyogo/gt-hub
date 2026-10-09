import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigStore, DEFAULT_SERVER_URL } from '../src/client/config/configStore';

describe('ConfigStore Multi-Context Architecture', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `gt-ctx-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    process.env.GT_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('auto-initializes default context when config is empty', () => {
    const config = ConfigStore.load();
    expect(config.currentContext).toBe('default');
    expect(config.contexts).toBeDefined();
    expect(config.contexts.default).toEqual({
      server: DEFAULT_SERVER_URL,
      key: '',
    });
    expect(config.machineId).toBeDefined();
  });

  it('supports adding and switching contexts', () => {
    ConfigStore.setContext('prod', { server: 'https://hub.prod.com', key: 'prod-secret' });
    expect(ConfigStore.getContexts()['prod']).toEqual({
      server: 'https://hub.prod.com',
      key: 'prod-secret',
    });

    ConfigStore.useContext('prod');
    expect(ConfigStore.getCurrentContext()).toBe('prod');

    const effective = ConfigStore.getEffectiveConfig({}, {});
    expect(effective.server).toBe('https://hub.prod.com');
    expect(effective.key).toBe('prod-secret');
    expect(effective.context).toBe('prod');
  });

  it('falls back to default when deleting active context', () => {
    ConfigStore.setContext('staging', { server: 'https://hub.staging.com', key: 'staging-key' });
    ConfigStore.useContext('staging');
    expect(ConfigStore.getCurrentContext()).toBe('staging');

    ConfigStore.deleteContext('staging');
    expect(ConfigStore.getCurrentContext()).toBe('default');
    expect(ConfigStore.getContexts()['staging']).toBeUndefined();
  });

  it('resets default context instead of deleting it', () => {
    ConfigStore.setContext('default', { server: 'http://custom:9000', key: 'custom-key' });
    const result = ConfigStore.deleteContext('default');

    expect(result.resetDefault).toBe(true);
    expect(ConfigStore.getCurrentContext()).toBe('default');
    expect(ConfigStore.getContexts()['default']).toEqual({
      server: DEFAULT_SERVER_URL,
      key: '',
    });
  });

  it('respects precedence: flag > env > context flag > currentContext > default', () => {
    ConfigStore.setContext('prod', { server: 'http://context-prod:8000', key: 'key-prod' });
    ConfigStore.setContext('dev', { server: 'http://context-dev:8000', key: 'key-dev' });
    ConfigStore.useContext('prod');

    // 1. Current context
    expect(ConfigStore.getEffectiveConfig({}, {}).server).toBe('http://context-prod:8000');

    // 2. Context flag overrides current context
    expect(ConfigStore.getEffectiveConfig({ context: 'dev' }, {}).server).toBe('http://context-dev:8000');

    // 3. Env overrides context flag
    expect(ConfigStore.getEffectiveConfig({ context: 'dev' }, { GT_SERVER: 'http://env:8000' }).server).toBe('http://env:8000');

    // 4. CLI flag overrides env
    expect(ConfigStore.getEffectiveConfig({ server: 'http://cli:8000', context: 'dev' }, { GT_SERVER: 'http://env:8000' }).server).toBe('http://cli:8000');
  });
});
