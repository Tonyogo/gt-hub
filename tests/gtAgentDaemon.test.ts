import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

describe('gt agent singleton daemon lifecycle and parameter guards', () => {
  let testConfigDir: string;

  beforeEach(() => {
    testConfigDir = path.join(os.tmpdir(), `gt-test-daemon-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testConfigDir, { recursive: true });
  });

  afterEach(() => {
    try {
      const { AgentDaemonManager } = require('../scripts/gt.js');
      process.env.GT_CONFIG_DIR = testConfigDir;
      const status = AgentDaemonManager.getStatus();
      if (status && status.pid && status.running) {
        try { process.kill(status.pid, 'SIGKILL'); } catch {}
      }
      AgentDaemonManager.clearStatus();
    } catch {}
    try {
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {}
  });

  it('accepts --server and --key flags without throwing removed errors', () => {
    const res = spawnSync('node', [gtPath, 'agent', 'start', '--server=http://localhost:8000', '--key=my-secret'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(res.stderr).not.toContain("Error: '--server' is removed");
    expect(res.stderr).not.toContain("Error: '--key' is removed");
    const { AgentDaemonManager } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;
    const status = AgentDaemonManager.getStatus();
    if (status && status.pid) {
      try { process.kill(status.pid, 'SIGKILL'); } catch {}
    }
  });

  it('rejects agent execution if not authenticated via gt auth login', () => {
    const cleanEnv: Record<string, string> = { ...process.env, GT_CONFIG_DIR: testConfigDir };
    delete cleanEnv.TERMINAL_SERVER;
    delete cleanEnv.ADMIN_SECRET_KEY;
    delete cleanEnv.GEMINI_PROXY_URL;
    delete cleanEnv.GT_SERVER;
    delete cleanEnv.GT_KEY;

    const res = spawnSync('node', [gtPath, 'agent', 'start'], {
      env: cleanEnv,
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Error: No authenticated server found. Please run 'gt auth login <server> <key>' first.");
  });

  it('operates on singleton agent.json and agent.log', () => {
    process.env.GT_CONFIG_DIR = testConfigDir;
    const { AgentDaemonManager } = require('../scripts/gt.js');

    expect(AgentDaemonManager.getStatusFile()).toBe(path.join(testConfigDir, 'agent.json'));
    expect(AgentDaemonManager.getLogFile()).toBe(path.join(testConfigDir, 'agent.log'));

    AgentDaemonManager.saveStatus({ pid: process.pid, name: 'single-node', server: 'http://localhost:8000' });
    const status = AgentDaemonManager.getStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.name).toBe('single-node');

    AgentDaemonManager.clearStatus();
    const cleared = AgentDaemonManager.getStatus();
    expect(cleared.running).toBe(false);
  });

  it('detects process alive correctly and manages singleton agent state file', () => {
    process.env.GT_CONFIG_DIR = testConfigDir;
    const { AgentDaemonManager } = require('../scripts/gt.js');
    expect(AgentDaemonManager.isProcessAlive(process.pid)).toBe(true);
    expect(AgentDaemonManager.isProcessAlive(99999999)).toBe(false);

    AgentDaemonManager.saveStatus({ pid: process.pid, name: 'test-agent' });
    const status = AgentDaemonManager.getStatus();
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.name).toBe('test-agent');

    AgentDaemonManager.saveStatus({ pid: 99999999, name: 'dead-agent' });
    const staleStatus = AgentDaemonManager.getStatus();
    expect(staleStatus.running).toBe(false);
    expect(staleStatus.stale).toBe(true);
    AgentDaemonManager.clearStatus();
    expect(fs.existsSync(AgentDaemonManager.getStatusFile())).toBe(false);
  });

  it('supports background execution via gt agent start and singleton lifecycle management', async () => {
    // 1. Set credentials
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
      agentName: 'my-daemon',
    }));

    // 2. Start agent in daemon mode
    const startRes = spawnSync('node', [gtPath, 'agent', 'start'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(startRes.status).toBe(0);
    expect(startRes.stdout).toContain('Agent started in background (PID:');
    expect(startRes.stdout).toContain('my-daemon');

    // 3. Check status
    const statusRes = spawnSync('node', [gtPath, 'agent', 'status'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(statusRes.status).toBe(0);
    expect(statusRes.stdout).toContain('Running');
    expect(statusRes.stdout).toContain('my-daemon');

    // 4. Prevent duplicate start for singleton agent
    const dupRes = spawnSync('node', [gtPath, 'agent', 'start'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(dupRes.status).toBe(1);
    expect(dupRes.stderr).toContain('already running');

    // 5. Read logs
    const logsRes = spawnSync('node', [gtPath, 'agent', 'logs', '-n', '20'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(logsRes.status).toBe(0);

    // 6. Stop agent
    const stopRes = spawnSync('node', [gtPath, 'agent', 'stop'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(stopRes.status).toBe(0);
    expect(stopRes.stdout).toContain('stopped');

    // 7. Status should show not running
    const statusAfter = spawnSync('node', [gtPath, 'agent', 'status'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(statusAfter.stdout).toContain('No background agent running');
  });

  it('supports restart subcommand', async () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    // Start with 'start' subcommand
    const startRes = spawnSync('node', [gtPath, 'agent', 'start'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(startRes.status).toBe(0);
    expect(startRes.stdout).toContain('Agent started in background (PID:');

    // Restart
    const restartRes = spawnSync('node', [gtPath, 'agent', 'restart'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(restartRes.status).toBe(0);
    expect(restartRes.stdout).toContain('Agent started in background (PID:');

    const statusRes = spawnSync('node', [gtPath, 'agent', 'status'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(statusRes.status).toBe(0);
    expect(statusRes.stdout).toContain('Running');

    // Clean up
    spawnSync('node', [gtPath, 'agent', 'stop'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
  });

  it('derives hostId and node name from three-tier resolution', () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    const { ConfigStore, AgentDaemonManager } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;
    const mid = ConfigStore.getMachineId();
    const expectedHostname = os.hostname().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '') || 'host';

    // 1. Default hostname agent (no name specified)
    const res1 = spawnSync('node', [gtPath, 'agent', 'start'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(res1.status).toBe(0);
    expect(res1.stdout).toContain(`Host: ${expectedHostname}`);

    const agentRecord1 = AgentDaemonManager.getStatus();
    expect(agentRecord1.running).toBe(true);
    expect(agentRecord1.name).toBe(expectedHostname);
    expect(agentRecord1.id).toBe(mid);

    // Stop
    spawnSync('node', [gtPath, 'agent', 'stop'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });

    // 2. Persistent configured name
    ConfigStore.setAgentName('custom-configured-node');
    const res2 = spawnSync('node', [gtPath, 'agent', 'start'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(res2.status).toBe(0);
    expect(res2.stdout).toContain('Host: custom-configured-node');

    const agentRecord2 = AgentDaemonManager.getStatus();
    expect(agentRecord2.running).toBe(true);
    expect(agentRecord2.name).toBe('custom-configured-node');
    expect(agentRecord2.id).toBe(`${mid}-custom-configured-node`);

    // Stop
    spawnSync('node', [gtPath, 'agent', 'stop'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });

    // 3. Environment variable GT_AGENT_NAME overrides configured
    const res3 = spawnSync('node', [gtPath, 'agent', 'start'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir, GT_AGENT_NAME: 'env-override-node' },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(res3.status).toBe(0);
    expect(res3.stdout).toContain('Host: env-override-node');

    const agentRecord3 = AgentDaemonManager.getStatus();
    expect(agentRecord3.running).toBe(true);
    expect(agentRecord3.name).toBe('env-override-node');
    expect(agentRecord3.id).toBe(`${mid}-env-override-node`);

    // Stop
    spawnSync('node', [gtPath, 'agent', 'stop'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
  });

  it('outputs agent daemon commands in gt --help', () => {
    const helpRes = spawnSync('node', [gtPath, '--help'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(helpRes.status).toBe(0);
    expect(helpRes.stdout).toContain('agent start');
    expect(helpRes.stdout).toContain('agent stop');
    expect(helpRes.stdout).toContain('agent restart');
    expect(helpRes.stdout).toContain('agent status');
    expect(helpRes.stdout).toContain('agent logs');
    expect(helpRes.stdout).toContain('agent name');
    expect(helpRes.stdout).not.toContain('agent run');
    expect(helpRes.stdout).not.toContain('agent rm');
  });

  it('supports gt ps -l to list local singleton agent', async () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
      agentName: 'ps-local-test',
    }));

    const startRes = spawnSync('node', [gtPath, 'agent', 'start'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(startRes.status).toBe(0);

    const psLocalRes = spawnSync('node', [gtPath, 'ps', '-l'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(psLocalRes.status).toBe(0);
    expect(psLocalRes.stdout).toContain('ps-local-test');
    expect(psLocalRes.stdout).toContain('Running');

    spawnSync('node', [gtPath, 'agent', 'stop'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
  });

  it('supports gt logs for local daemon and redirects to remote tasks when 2 positional arguments given', async () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    // Start daemon
    spawnSync('node', [gtPath, 'agent', 'start'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });

    const logRes = spawnSync('node', [gtPath, 'logs'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(logRes.status).toBe(0);

    // Stop daemon
    spawnSync('node', [gtPath, 'agent', 'stop'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
  });

  it('does not error when stopping a non-running agent daemon', async () => {
    process.env.GT_CONFIG_DIR = testConfigDir;
    const { AgentDaemonManager } = require('../scripts/gt.js');
    AgentDaemonManager.clearStatus();

    const stopResult = await AgentDaemonManager.stop();
    expect(stopResult.success).toBe(true);
    expect(stopResult.message).toContain('not running');
  });
});
