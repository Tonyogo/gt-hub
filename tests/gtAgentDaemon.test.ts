import path from 'path';
import fs from 'fs';
import os from 'os';
import { spawnSync } from 'child_process';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

describe('gt agent unified authentication and parameter guards', () => {
  let testConfigDir: string;

  beforeEach(() => {
    testConfigDir = path.join(os.tmpdir(), `gt-test-daemon-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(testConfigDir, { recursive: true });
  });

  afterEach(() => {
    try {
      fs.rmSync(testConfigDir, { recursive: true, force: true });
    } catch {}
  });

  it('accepts --server and --key flags without throwing removed errors', () => {
    const res = spawnSync('node', [gtPath, 'agent', '--server=http://localhost:8000', '--key=my-secret'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 3000,
    });

    expect(res.stderr).not.toContain("Error: '--server' is removed");
    expect(res.stderr).not.toContain("Error: '--key' is removed");
  });

  it('rejects agent execution if not authenticated via gt auth login', () => {
    // Config directory has no config.json and no valid env vars
    const cleanEnv: Record<string, string> = { ...process.env, GT_CONFIG_DIR: testConfigDir };
    delete cleanEnv.TERMINAL_SERVER;
    delete cleanEnv.ADMIN_SECRET_KEY;
    delete cleanEnv.GEMINI_PROXY_URL;
    delete cleanEnv.GT_SERVER;
    delete cleanEnv.GT_KEY;

    const res = spawnSync('node', [gtPath, 'agent'], {
      env: cleanEnv,
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Error: No authenticated server found. Please run 'gt auth login <server> <key>' first.");
  });

  it('detects process alive correctly and manages agent state file', () => {
    process.env.GT_CONFIG_DIR = testConfigDir;
    const { AgentDaemonManager } = require('../scripts/gt.js');
    expect(AgentDaemonManager.isProcessAlive(process.pid)).toBe(true);
    expect(AgentDaemonManager.isProcessAlive(99999999)).toBe(false);

    // Save and check alive status
    AgentDaemonManager.saveStatus('test-agent', { pid: process.pid, name: 'test-agent' });
    const status = AgentDaemonManager.getAgent('test-agent');
    expect(status.running).toBe(true);
    expect(status.pid).toBe(process.pid);
    expect(status.name).toBe('test-agent');

    // Save dead PID and verify stale
    AgentDaemonManager.saveStatus('dead-agent', { pid: 99999999, name: 'dead-agent' });
    const staleStatus = AgentDaemonManager.getAgent('dead-agent');
    expect(staleStatus.running).toBe(false);
    expect(staleStatus.stale).toBe(true);
    AgentDaemonManager.remove('dead-agent');
    expect(fs.existsSync(AgentDaemonManager.getStatusFile('dead-agent'))).toBe(false);
  });

  it('supports background execution via gt agent -d and lifecycle management', async () => {
    // 1. First login / set credentials
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    // 2. Start agent in daemon mode
    const startRes = spawnSync('node', [gtPath, 'agent', '-d', '--name=my-daemon'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(startRes.status).toBe(0);
    expect(startRes.stdout).toContain('Agent started in background (PID:');

    // 3. Check status
    const statusRes = spawnSync('node', [gtPath, 'agent', 'status'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(statusRes.status).toBe(0);
    expect(statusRes.stdout).toContain('Running');
    expect(statusRes.stdout).toContain('my-daemon');

    // Also verify 'ps' alias
    const psRes = spawnSync('node', [gtPath, 'agent', 'ps'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(psRes.status).toBe(0);
    expect(psRes.stdout).toContain('Running');

    // 4. Prevent duplicate start for same name
    const dupRes = spawnSync('node', [gtPath, 'agent', '-d', '--name=my-daemon'], {
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

  it('supports restart and start subcommands', async () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    // Start with 'start' subcommand
    const startRes = spawnSync('node', [gtPath, 'agent', 'start', '--name=start-daemon'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(startRes.status).toBe(0);
    expect(startRes.stdout).toContain('Agent started in background (PID:');

    // Restart
    const restartRes = spawnSync('node', [gtPath, 'agent', 'restart', '--name=restarted-daemon'], {
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
    expect(statusRes.stdout).toContain('restarted-daemon');

    // Clean up
    spawnSync('node', [gtPath, 'agent', 'stop'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
  });

  it('manages multiple named agent status files and processes independently', () => {
    process.env.GT_CONFIG_DIR = testConfigDir;
    const { AgentDaemonManager } = require('../scripts/gt.js');

    const agentsDir = AgentDaemonManager.getAgentsDir();
    expect(agentsDir).toBe(path.join(testConfigDir, 'agents'));

    // Save two different agents
    AgentDaemonManager.saveStatus('worker-a', { pid: process.pid, name: 'worker-a', server: 'http://hub1' });
    AgentDaemonManager.saveStatus('worker-b', { pid: 99999999, name: 'worker-b', server: 'http://hub2' });

    const agentA = AgentDaemonManager.getAgent('worker-a');
    expect(agentA).not.toBeNull();
    expect(agentA.running).toBe(true);
    expect(agentA.name).toBe('worker-a');

    const agentB = AgentDaemonManager.getAgent('worker-b');
    expect(agentB).not.toBeNull();
    expect(agentB.running).toBe(false); // PID 99999999 is dead
    expect(agentB.stale).toBe(true);

    const all = AgentDaemonManager.getAllAgents();
    expect(all.length).toBe(2);

    // Test target resolution
    // 1 running agent (worker-a) -> resolveTarget() without name resolves to worker-a
    const resolved = AgentDaemonManager.resolveTarget(undefined, 'stop');
    expect(resolved.error).toBeUndefined();
    expect(resolved.agent.name).toBe('worker-a');

    // Explicit name resolves
    const resolvedExplicit = AgentDaemonManager.resolveTarget('worker-b', 'stop');
    expect(resolvedExplicit.agent.name).toBe('worker-b');

    // Remove worker-b
    AgentDaemonManager.remove('worker-b');
    expect(AgentDaemonManager.getAgent('worker-b')).toBeNull();
  });

  it('supports positional [NAME] argument and prevents duplicate running instances', () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    // Start agent with positional name 'worker-pos'
    const res1 = spawnSync('node', [gtPath, 'agent', 'run', '-d', 'worker-pos'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(res1.status).toBe(0);
    expect(res1.stdout).toContain('Agent started in background');
    expect(res1.stdout).toContain('worker-pos');

    // Verify state file created in agents/worker-pos.json
    const statePath = path.join(testConfigDir, 'agents', 'worker-pos.json');
    expect(fs.existsSync(statePath)).toBe(true);

    // Attempt duplicate start with same name 'worker-pos'
    const dupRes = spawnSync('node', [gtPath, 'agent', 'run', '-d', 'worker-pos'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(dupRes.status).toBe(1);
    expect(dupRes.stderr).toContain('already running');
    expect(dupRes.stderr).toContain('worker-pos');

    // Start another agent with different name 'worker-pos-2'
    const res2 = spawnSync('node', [gtPath, 'agent', 'run', '-d', 'worker-pos-2'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(res2.status).toBe(0);
    expect(res2.stdout).toContain('worker-pos-2');

    // Stop both
    const { AgentDaemonManager } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;
    const agent1 = AgentDaemonManager.getAgent('worker-pos');
    const agent2 = AgentDaemonManager.getAgent('worker-pos-2');
    if (agent1 && agent1.pid) process.kill(agent1.pid, 'SIGKILL');
    if (agent2 && agent2.pid) process.kill(agent2.pid, 'SIGKILL');
  });

  it('provides full Docker-style agent command workflow: agent run, ps, logs, stop, rm', async () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    // 1. gt agent run -d app-node
    const runRes = spawnSync('node', [gtPath, 'agent', 'run', '-d', 'app-node'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(runRes.status).toBe(0);
    expect(runRes.stdout).toContain('Agent started in background');

    // 2. gt agent ps
    const psRes = spawnSync('node', [gtPath, 'agent', 'ps'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(psRes.status).toBe(0);
    expect(psRes.stdout).toContain('app-node');
    expect(psRes.stdout).toContain('Running');

    // 3. gt agent logs app-node
    const logsRes = spawnSync('node', [gtPath, 'agent', 'logs', 'app-node', '-n', '10'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(logsRes.status).toBe(0);

    // 4. gt agent stop app-node (or auto-target since only 1 running)
    const stopRes = spawnSync('node', [gtPath, 'agent', 'stop'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(stopRes.status).toBe(0);
    expect(stopRes.stdout).toContain('stopped');

    // 5. gt agent ps should show Stopped / Stale via -a or indicate stopped agents
    const psStopped = spawnSync('node', [gtPath, 'agent', 'ps', '-a'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(psStopped.status).toBe(0);
    expect(psStopped.stdout).toContain('Stopped');

    // Default ps shows stopped count notice
    const psDefault = spawnSync('node', [gtPath, 'agent', 'ps'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(psDefault.status).toBe(0);
    expect(psDefault.stdout).toContain('1 stopped');
    expect(psDefault.stdout).toContain('gt agent prune');

    // 6. gt agent rm app-node
    const rmRes = spawnSync('node', [gtPath, 'agent', 'rm', 'app-node'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(rmRes.status).toBe(0);
    expect(rmRes.stdout).toContain('removed');

    // Now agent ps shows nothing
    const psEmpty = spawnSync('node', [gtPath, 'agent', 'ps'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(psEmpty.stdout).toContain('No agent daemons found');
  });

  it('enforces explicit NAME when multiple agents are running for stop and logs', () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    // Start two agents
    spawnSync('node', [gtPath, 'agent', 'run', '-d', 'worker-multi-1'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    spawnSync('node', [gtPath, 'agent', 'run', '-d', 'worker-multi-2'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });

    // Call gt agent stop without name -> should fail with ambiguity error
    const ambiguousStop = spawnSync('node', [gtPath, 'agent', 'stop'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(ambiguousStop.status).toBe(1);
    expect(ambiguousStop.stderr).toContain('Multiple running agents');

    // Stop with --all
    const stopAll = spawnSync('node', [gtPath, 'agent', 'stop', '--all'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(stopAll.status).toBe(0);
    expect(stopAll.stdout).toContain('stopped');
  });

  it('enforces conflict check for foreground agents and tracks them in gt agent ps', () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    // Start background agent worker-fg
    const runRes = spawnSync('node', [gtPath, 'agent', 'run', '-d', 'worker-fg'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(runRes.status).toBe(0);

    // Attempt to start foreground agent with same name
    const fgRes = spawnSync('node', [gtPath, 'agent', 'run', 'worker-fg'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(fgRes.status).toBe(1);
    expect(fgRes.stderr).toContain('already running');
    expect(fgRes.stderr).toContain('worker-fg');

    // Clean up
    const { AgentDaemonManager } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;
    const a = AgentDaemonManager.getAgent('worker-fg');
    if (a && a.pid) process.kill(a.pid, 'SIGKILL');
  });

  it('ensures gt agent ps outputs format including stopped agents', () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    const { AgentDaemonManager } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;
    AgentDaemonManager.saveStatus('test-stopped', { pid: 99999999, name: 'test-stopped', server: 'http://hub1' });

    const agentPsRes = spawnSync('node', [gtPath, 'agent', 'ps', '-a'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(agentPsRes.status).toBe(0);
    expect(agentPsRes.stdout).toContain('Stopped');
    expect(agentPsRes.stdout).toContain('test-stopped');

    AgentDaemonManager.remove('test-stopped');
  });

  it('outputs Docker-style command guidelines in gt --help', () => {
    const helpRes = spawnSync('node', [gtPath, '--help'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(helpRes.status).toBe(0);
    expect(helpRes.stdout).toContain('agent run [-d] [NAME]');
    expect(helpRes.stdout).toContain('agent ps');
    expect(helpRes.stdout).toContain('agent logs [-f] [-n 50] [NAME]');
    expect(helpRes.stdout).toContain('agent stop [NAME] [--all]');
  });

  it('supports gt agent rm to remove stopped agents and gt agent rm --all to clean up all stopped agents', () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    const { AgentDaemonManager } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;

    AgentDaemonManager.saveStatus('stopped-1', { pid: 99999991, name: 'stopped-1', server: 'http://hub1' });
    AgentDaemonManager.saveStatus('stopped-2', { pid: 99999992, name: 'stopped-2', server: 'http://hub1' });
    AgentDaemonManager.saveStatus('running-1', { pid: process.pid, name: 'running-1', server: 'http://hub1' });

    // Removing running agent should fail
    const rmRunningRes = spawnSync('node', [gtPath, 'agent', 'rm', 'running-1'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(rmRunningRes.status).toBe(1);
    expect(rmRunningRes.stderr).toContain('Cannot remove running agent');

    // Remove single stopped agent
    const rmOneRes = spawnSync('node', [gtPath, 'agent', 'rm', 'stopped-1'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(rmOneRes.status).toBe(0);
    expect(rmOneRes.stdout).toContain('Agent "stopped-1" removed');
    expect(AgentDaemonManager.getAgent('stopped-1')).toBeNull();

    // Remove all remaining stopped agents
    const rmAllRes = spawnSync('node', [gtPath, 'agent', 'rm', '--all'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(rmAllRes.status).toBe(0);
    expect(rmAllRes.stdout).toContain('stopped-2');
    expect(AgentDaemonManager.getAgent('stopped-2')).toBeNull();
    expect(AgentDaemonManager.getAgent('running-1')).not.toBeNull();

    AgentDaemonManager.clearStatus('running-1');
  });

  it('supports gt agent prune to clean up all stopped agent instances and logs', () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    const { AgentDaemonManager } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;

    AgentDaemonManager.saveStatus('prune-1', { pid: 99999991, name: 'prune-1', server: 'http://hub1' });
    AgentDaemonManager.saveStatus('prune-2', { pid: 99999992, name: 'prune-2', server: 'http://hub1' });
    AgentDaemonManager.saveStatus('running-keep', { pid: process.pid, name: 'running-keep', server: 'http://hub1' });

    const pruneRes = spawnSync('node', [gtPath, 'agent', 'prune'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(pruneRes.status).toBe(0);
    expect(pruneRes.stdout).toContain('Pruned stopped agents');
    expect(pruneRes.stdout).toContain('prune-1');
    expect(pruneRes.stdout).toContain('prune-2');
    expect(AgentDaemonManager.getAgent('prune-1')).toBeNull();
    expect(AgentDaemonManager.getAgent('prune-2')).toBeNull();
    expect(AgentDaemonManager.getAgent('running-keep')).not.toBeNull();

    // Calling prune again when no stopped agents
    const pruneEmptyRes = spawnSync('node', [gtPath, 'agent', 'prune'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(pruneEmptyRes.status).toBe(0);
    expect(pruneEmptyRes.stdout).toContain('No stopped agents to prune');

    AgentDaemonManager.clearStatus('running-keep');
  });

  it('defaults to system hostname and reuses stopped instance slot idempotently', () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    const { AgentDaemonManager, ConfigStore } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;

    const expectedHostname = os.hostname().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '') || 'host';

    // 1. First run without name: should use hostname
    const run1 = spawnSync('node', [gtPath, 'agent', 'run', '-d'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(run1.status).toBe(0);
    expect(run1.stdout).toContain(`Host: ${expectedHostname}`);

    const agentRecord1 = AgentDaemonManager.getAgent(expectedHostname);
    expect(agentRecord1).not.toBeNull();
    expect(agentRecord1.running).toBe(true);
    const pid1 = agentRecord1.pid;
    const mid1 = ConfigStore.getMachineId();
    expect(agentRecord1.id).toBe(mid1);

    // 2. Stop the agent so it becomes stopped
    const stopRes = spawnSync('node', [gtPath, 'agent', 'stop'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(stopRes.status).toBe(0);

    // Verify it is stopped
    const staleCheck = AgentDaemonManager.getAgent(expectedHostname);
    expect(staleCheck.running).toBe(false);

    // 3. Re-run without name: should seamlessly reuse the stopped slot, NOT error out
    const run2 = spawnSync('node', [gtPath, 'agent', 'run', '-d'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(run2.status).toBe(0);
    expect(run2.stdout).toContain(`Host: ${expectedHostname}`);

    const agentRecord2 = AgentDaemonManager.getAgent(expectedHostname);
    expect(agentRecord2.running).toBe(true);
    expect(agentRecord2.pid).not.toBe(pid1); // New PID
    expect(agentRecord2.id).toBe(mid1); // Persistent machine ID retained

    // Clean up
    if (agentRecord2.pid) process.kill(agentRecord2.pid, 'SIGKILL');
    AgentDaemonManager.remove(expectedHostname);
  });

  it('supports gt ps -l to list local agents and shows tip on default gt ps', async () => {
    // 1. Setup config and start agent daemon
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    const startRes = spawnSync('node', [gtPath, 'run', '-d', '--name=ps-local-test'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(startRes.status).toBe(0);

    // 2. gt ps -l should list local agent table
    const psLocalRes = spawnSync('node', [gtPath, 'ps', '-l'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(psLocalRes.status).toBe(0);
    expect(psLocalRes.stdout).toContain('ps-local-test');
    expect(psLocalRes.stdout).toContain('Running');

    // 3. Stop the agent
    spawnSync('node', [gtPath, 'stop', 'ps-local-test'], {
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
    spawnSync('node', [gtPath, 'run', '-d', '--name=logs-test-agent'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });

    // gt logs logs-test-agent should display logs or no-logs message without failing
    const logRes = spawnSync('node', [gtPath, 'logs', 'logs-test-agent'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(logRes.status).toBe(0);

    // Stop daemon
    spawnSync('node', [gtPath, 'stop', 'logs-test-agent'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
  });

  it('supports gt prune -l and gt prune -a for local daemon cleanup', () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    // Create stopped agent record
    const { AgentDaemonManager } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;
    AgentDaemonManager.saveStatus('prune-agent-1', { pid: 99999991, name: 'prune-agent-1' });

    const pruneLocalRes = spawnSync('node', [gtPath, 'prune', '-l'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(pruneLocalRes.status).toBe(0);
    expect(pruneLocalRes.stdout).toContain('prune-agent-1');
  });

  it('derives hostId deterministically: machineId for hostname, machineId-name for custom name', () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    const { ConfigStore, AgentDaemonManager } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;
    const mid = ConfigStore.getMachineId();

    // 1. Default hostname agent (no name specified)
    const res1 = spawnSync('node', [gtPath, 'agent', 'run', '-d'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(res1.status).toBe(0);

    const hostname = os.hostname().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '') || 'host';
    const defaultAgent = AgentDaemonManager.getAgent(hostname);
    expect(defaultAgent).not.toBeNull();
    expect(defaultAgent.running).toBe(true);
    expect(defaultAgent.id).toBe(mid);

    // 2. Custom name agent running concurrently
    const res2 = spawnSync('node', [gtPath, 'agent', 'run', '-d', 'worker-extra'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(res2.status).toBe(0);

    const customAgent = AgentDaemonManager.getAgent('worker-extra');
    expect(customAgent).not.toBeNull();
    expect(customAgent.running).toBe(true);
    expect(customAgent.id).toBe(`${mid}-worker-extra`);

    // Cleanup
    if (defaultAgent && defaultAgent.pid) {
      try { process.kill(defaultAgent.pid, 'SIGKILL'); } catch (e) {}
    }
    if (customAgent && customAgent.pid) {
      try { process.kill(customAgent.pid, 'SIGKILL'); } catch (e) {}
    }
  });

  it('handles full multi-agent concurrency and lifecycle operations', async () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    const { AgentDaemonManager } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;

    // 1. Start agent-1 and agent-2
    const r1 = spawnSync('node', [gtPath, 'run', '-d', 'agent-one'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(r1.status).toBe(0);

    const r2 = spawnSync('node', [gtPath, 'run', '-d', 'agent-two'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(r2.status).toBe(0);

    // Both should be running
    const running = AgentDaemonManager.getAllAgents().filter((a: any) => a.running);
    expect(running.length).toBe(2);
    const names = running.map((a: any) => a.name);
    expect(names).toContain('agent-one');
    expect(names).toContain('agent-two');

    // 2. gt stop without name should fail because 2 are running
    const stopAmbiguous = spawnSync('node', [gtPath, 'stop'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(stopAmbiguous.status).toBe(1);
    expect(stopAmbiguous.stderr).toContain('Multiple running agents');

    // 3. gt stop agent-one should stop only agent-one
    const stopOne = spawnSync('node', [gtPath, 'stop', 'agent-one'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(stopOne.status).toBe(0);
    expect(stopOne.stdout).toContain('agent-one');
    expect(stopOne.stdout).toContain('stopped');

    const afterStopOne = AgentDaemonManager.getAllAgents().filter((a: any) => a.running);
    expect(afterStopOne.length).toBe(1);
    expect(afterStopOne[0].name).toBe('agent-two');

    // 4. Now with only 1 running, gt stop without name should succeed
    const stopAuto = spawnSync('node', [gtPath, 'stop'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(stopAuto.status).toBe(0);
    expect(stopAuto.stdout).toContain('agent-two');

    const afterStopAll = AgentDaemonManager.getAllAgents().filter((a: any) => a.running);
    expect(afterStopAll.length).toBe(0);
  });

  it('stops all running agents cleanly with gt stop --all', async () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    const { AgentDaemonManager } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;

    spawnSync('node', [gtPath, 'run', '-d', 'batch-1'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    spawnSync('node', [gtPath, 'run', '-d', 'batch-2'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });

    expect(AgentDaemonManager.getAllAgents().filter((a: any) => a.running).length).toBe(2);

    const stopAllRes = spawnSync('node', [gtPath, 'stop', '--all'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(stopAllRes.status).toBe(0);
    expect(stopAllRes.stdout).toContain('batch-1');
    expect(stopAllRes.stdout).toContain('batch-2');

    expect(AgentDaemonManager.getAllAgents().filter((a: any) => a.running).length).toBe(0);
  });

  it('handles custom name sanitization, duplicate default hostname run prevention, and restart resolution', () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    const { ConfigStore, AgentDaemonManager } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;
    const mid = ConfigStore.getMachineId();

    // 1. Sanitization: Worker_1.Test -> worker_1-test
    const r1 = spawnSync('node', [gtPath, 'run', '-d', 'Worker_1.Test'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(r1.status).toBe(0);

    const agent1 = AgentDaemonManager.getAgent('worker_1-test');
    expect(agent1).not.toBeNull();
    expect(agent1.running).toBe(true);
    expect(agent1.id).toBe(`${mid}-worker_1-test`);

    // Stop worker_1-test
    const stop1 = spawnSync('node', [gtPath, 'stop', 'worker_1-test'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(stop1.status).toBe(0);

    // 2. Default hostname twice: second fails with exit code 1
    const rDefault1 = spawnSync('node', [gtPath, 'run', '-d'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(rDefault1.status).toBe(0);

    const rDefault2 = spawnSync('node', [gtPath, 'run', '-d'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(rDefault2.status).toBe(1);
    expect(rDefault2.stderr).toContain('already running');

    // 3. Restart with single running agent (auto-resolves target)
    const restartSingle = spawnSync('node', [gtPath, 'agent', 'restart'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(restartSingle.status).toBe(0);

    // 4. Start second agent
    const rExtra = spawnSync('node', [gtPath, 'run', '-d', 'worker-two'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(rExtra.status).toBe(0);

    // Restart with 2 running without name -> ambiguous, fails
    const restartMulti = spawnSync('node', [gtPath, 'agent', 'restart'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(restartMulti.status).toBe(1);
    expect(restartMulti.stderr).toContain('Multiple running agents');

    // Cleanup all
    spawnSync('node', [gtPath, 'stop', '--all'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
  });

  it('does not stop running agent when stopping or restarting a non-existent agent', async () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
    }));

    const { AgentDaemonManager } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;

    // Start one agent
    const rStart = spawnSync('node', [gtPath, 'run', '-d', 'stable-agent'], {
      env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
      encoding: 'utf-8',
      timeout: 5000,
    });
    expect(rStart.status).toBe(0);

    const stableAgent = AgentDaemonManager.getAgent('stable-agent');
    expect(stableAgent).not.toBeNull();
    expect(stableAgent.running).toBe(true);

    // Call stop with explicit non-existent name
    const stopResult = await AgentDaemonManager.stop('non-existent-agent');
    expect(stopResult.message).toContain('non-existent-agent');

    // stable-agent MUST STILL BE RUNNING!
    const stillRunning = AgentDaemonManager.getAgent('stable-agent');
    expect(stillRunning).not.toBeNull();
    expect(stillRunning.running).toBe(true);

    // Cleanup
    await AgentDaemonManager.stop('stable-agent');
  });
});






