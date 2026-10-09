import fs from 'fs';
import path from 'path';
import os from 'os';
import { ConfigStore } from '../src/client/config/configStore';

describe('ConfigStore Agent Name Configuration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `gt-name-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    process.env.GT_CONFIG_DIR = tmpDir;
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('persists and retrieves configured agent name', () => {
    expect(ConfigStore.getAgentName()).toBeUndefined();
    ConfigStore.setAgentName('worker-prod-01');
    expect(ConfigStore.getAgentName()).toBe('worker-prod-01');

    const raw = JSON.parse(fs.readFileSync(ConfigStore.getConfigFile(), 'utf-8'));
    expect(raw.agentName).toBe('worker-prod-01');
  });

  it('resolves agent name via three-tier hierarchy', () => {
    const defaultHost = os.hostname().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '') || 'host';

    // 1. Default hostname
    const defRes = ConfigStore.resolveAgentName({});
    expect(defRes.name).toBe(defaultHost);
    expect(defRes.source).toBe('default');

    // 2. Configured in config.json
    ConfigStore.setAgentName('custom-agent');
    const cfgRes = ConfigStore.resolveAgentName({});
    expect(cfgRes.name).toBe('custom-agent');
    expect(cfgRes.source).toBe('configured');

    // 3. Environment variable takes highest precedence
    const envRes = ConfigStore.resolveAgentName({ GT_AGENT_NAME: 'env-agent' });
    expect(envRes.name).toBe('env-agent');
    expect(envRes.source).toBe('environment');
  });
});
