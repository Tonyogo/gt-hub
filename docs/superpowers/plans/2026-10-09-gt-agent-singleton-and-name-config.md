# gt Agent Singleton Daemon & Dedicated Name Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `gt agent` into a pure singleton host daemon model, introduce `gt agent name [new-name]` for persistent node naming, remove `gt agent run` and legacy multi-instance commands/aliases, and consolidate file storage to `agent.json` and `agent.log`.

**Architecture:** Extend `ConfigStore` with `agentName` management and three-tier resolution (`GT_AGENT_NAME` > `config.agentName` > `os.hostname()`). Refactor `AgentDaemonManager` to drop multi-agent directory scanning and operate strictly on singleton files `~/.gt/agent.json` and `~/.gt/agent.log`. Reconfigure Commander CLI under `src/client/index.ts` to expose clean zero-parameter subcommands (`start`, `stop`, `restart`, `status`, `logs`, `name`) and drop obsolete commands/aliases (`run`, `rm`, `prune`, `ps`, `config get/set`).

**Tech Stack:** TypeScript 5.4, Commander.js 12.x, Node.js, esbuild, Jest 29, ts-jest.

**Spec:** `docs/superpowers/specs/2026-10-09-gt-agent-singleton-daemon-and-name-config-design.md`

## Global Constraints

- Standalone executable (`dist/gt.js`) must bundle cleanly with zero runtime dependencies.
- `gt agent start`, `stop`, `restart`, and `status` take NO positional `[name]` argument.
- `gt agent start` takes NO `--name` flag.
- `gt agent run`, `agent rm`, `agent prune`, `agent ps`, and top-level aliases `run`, `stop`, `restart`, `rm` must be completely removed.
- `gt config get <key>` and `gt config set <key> <val>` must be completely removed.
- State storage strictly uses `path.join(ConfigStore.getConfigDir(), 'agent.json')` and `agent.log`.
- `gt agent name` without arguments queries the active node name; `gt agent name <new-name>` sanitizes and persists `agentName` into `~/.gt/config.json`.

## Review Focus

1. **Three-Tier Name Resolution**: `GT_AGENT_NAME` environment variable overrides `ConfigStore.getAgentName()`, which overrides normalized `os.hostname()`.
2. **Singleton Mutex on Start**: Attempting `gt agent start` when an agent is already running must exit with code 1 and inform the user without spawning a duplicate daemon.
3. **Clean Stop and Status**: `gt agent stop` and `gt agent status` execute without requiring or accepting any name arguments.
4. **Log Streaming**: `gt agent logs -f` and `gt agent logs -n 50` read from singleton `agent.log` without requiring a name.
5. **CLI Error Handling**: Attempting removed commands like `gt agent run` or `gt run` must result in Commander unknown command error with exit code 2.

---

### Task 1: ConfigStore Agent Name Management & Three-Tier Resolution

**Files:**
- Modify: `src/client/config/configStore.ts`
- Create: `tests/gtAgentNameConfig.test.ts`

**Interfaces:**
- Consumes: `process.env.GT_AGENT_NAME`, `os.hostname()`
- Produces:
  - `ConfigStore.getAgentName(): string | undefined`
  - `ConfigStore.setAgentName(name: string): void`
  - `ConfigStore.resolveAgentName(env?): { name: string; source: 'environment' | 'configured' | 'default' }`

- [ ] **Step 1: Write failing unit test for agentName in ConfigStore**

Create `tests/gtAgentNameConfig.test.ts`:
```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/gtAgentNameConfig.test.ts`
Expected: FAIL (methods not defined on ConfigStore)

- [ ] **Step 3: Implement getAgentName, setAgentName, and resolveAgentName**

In `src/client/config/configStore.ts`:
```typescript
export class ConfigStore {
  // ... existing methods ...

  static getAgentName(): string | undefined {
    const data = this.load();
    return data.agentName && typeof data.agentName === 'string' ? data.agentName : undefined;
  }

  static setAgentName(name: string): void {
    const sanitized = name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '');
    if (!sanitized) {
      throw new Error('Invalid agent name. Must contain alphanumeric characters, dashes, or underscores.');
    }
    const data = this.load();
    data.agentName = sanitized;
    this.save(data);
  }

  static resolveAgentName(env: Record<string, string | undefined> = process.env): {
    name: string;
    source: 'environment' | 'configured' | 'default';
  } {
    if (env.GT_AGENT_NAME && env.GT_AGENT_NAME.trim().length > 0) {
      const sanitizedEnv = env.GT_AGENT_NAME.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '');
      if (sanitizedEnv) {
        return { name: sanitizedEnv, source: 'environment' };
      }
    }

    const configured = this.getAgentName();
    if (configured) {
      return { name: configured, source: 'configured' };
    }

    const host = os.hostname().toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '') || 'host';
    return { name: host, source: 'default' };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest tests/gtAgentNameConfig.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Task 1**

```bash
git add src/client/config/configStore.ts tests/gtAgentNameConfig.test.ts
git commit -m "feat(config): add agentName configuration and three-tier resolution hierarchy

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Refactor AgentDaemonManager to Singleton Model

**Files:**
- Modify: `src/agent/daemon.ts`
- Modify: `tests/gtAgentDaemon.test.ts`

**Interfaces:**
- Consumes: `ConfigStore.resolveAgentName()`, single file paths `agent.json` and `agent.log`
- Produces:
  - `AgentDaemonManager.getStatusFile(): string` (`~/.gt/agent.json`)
  - `AgentDaemonManager.getLogFile(): string` (`~/.gt/agent.log`)
  - `AgentDaemonManager.getStatus(): AgentStatus`
  - `AgentDaemonManager.saveStatus(state): void`
  - `AgentDaemonManager.clearStatus(): void`
  - `AgentDaemonManager.stop(): Promise<{ success: boolean; message: string; pid?: number }>`
  - `AgentDaemonManager.getLogs(lines, follow): Promise<void>`
  - `runAgent(agentArgs, globalOpts)` simplified for singleton operation (no `run`, no `rm`, no `prune`)

- [ ] **Step 1: Write failing unit tests for singleton AgentDaemonManager in tests/gtAgentDaemon.test.ts**

Update `tests/gtAgentDaemon.test.ts` to test singleton status, stop, and log paths:
```typescript
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
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx jest tests/gtAgentDaemon.test.ts -t "operates on singleton agent.json"`
Expected: FAIL

- [ ] **Step 3: Refactor AgentDaemonManager in src/agent/daemon.ts**

In `src/agent/daemon.ts`:
1. Simplify file paths to singleton:
```typescript
static getStatusFile(): string {
  return path.join(ConfigStore.getConfigDir(), 'agent.json');
}

static getLogFile(): string {
  return path.join(ConfigStore.getConfigDir(), 'agent.log');
}
```
2. Remove multi-agent directory operations: `getAgentsDir()`, `getAllAgents()`, `printAgentsTable()`, `resolveTarget()`, `removeAll()`, `prune()`, `remove()`.
3. Update `getStatus()`:
```typescript
static getStatus(): any {
  const p = this.getStatusFile();
  if (!fs.existsSync(p)) return { running: false };
  try {
    const state = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const alive = this.isProcessAlive(state.pid);
    return {
      running: alive,
      stale: !alive,
      ...state,
    };
  } catch {
    return { running: false };
  }
}

static saveStatus(state: any): void {
  const file = this.getStatusFile();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  }
  fs.writeFileSync(file, JSON.stringify(state, null, 2), { encoding: 'utf-8', mode: 0o600 });
}

static clearStatus(): void {
  try {
    const file = this.getStatusFile();
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {}
}

static async stop(): Promise<{ success: boolean; message: string; pid?: number }> {
  const current = this.getStatus();
  if (!current || !current.running) {
    this.clearStatus();
    return { success: true, message: 'Agent daemon is not running.' };
  }

  const pid = current.pid;
  try { process.kill(pid, 'SIGTERM'); } catch {}

  const start = Date.now();
  while (Date.now() - start < 3000) {
    if (!this.isProcessAlive(pid)) {
      this.clearStatus();
      return { success: true, pid, message: `Agent daemon (PID: ${pid}) stopped successfully.` };
    }
    await new Promise(r => setTimeout(r, 100));
  }

  killProcessTreeSync(pid, 'SIGKILL');
  this.clearStatus();
  return { success: true, pid, message: `Agent daemon (PID: ${pid}) forcibly terminated.` };
}

static async getLogs(lines: number = 50, follow: boolean = false): Promise<void> {
  const logFile = this.getLogFile();
  if (!fs.existsSync(logFile)) {
    console.log('No agent daemon log file found.');
    return;
  }
  // read and display lines / follow tail
  // ...
}
```
4. In `runAgent(agentArgs, globalOpts)`:
- Resolve host name via `ConfigStore.resolveAgentName().name` (drop positional name and `--name`).
- Drop `run`, `rm`, `prune`, `ps` subcommands.
- Subcommands supported: `start`, `stop`, `restart`, `status`, `logs`.
- If already running on `start`, error:
  `Error: Agent daemon is already running (PID: ${current.pid}). Use 'gt agent stop' or 'gt agent restart'.`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build:gt && npx jest tests/gtAgentDaemon.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Task 2**

```bash
git add src/agent/daemon.ts tests/gtAgentDaemon.test.ts
git commit -m "refactor(agent): consolidate daemon manager to singleton agent.json and agent.log

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Update Commander CLI Definitions & Clean up Redundant Commands

**Files:**
- Modify: `src/client/index.ts`
- Modify: `src/client/commands/config.ts`
- Modify: `tests/gtCommanderCli.test.ts`

**Interfaces:**
- Consumes: `AgentDaemonManager`, `ConfigStore`
- Produces:
  - `gt agent start [options]` (no name, no `--name`)
  - `gt agent stop`
  - `gt agent restart [options]`
  - `gt agent status`
  - `gt agent logs [-f] [-n]`
  - `gt agent name [new-name]`
  - Removed: `agent run`, `agent rm`, `agent prune`, `agent ps`, top-level `run`, `stop`, `restart`, `rm`, `config get`, `config set`

- [ ] **Step 1: Write test for new agent name command and removal of legacy commands**

In `tests/gtCommanderCli.test.ts`:
```typescript
it('supports gt agent name querying and setting', () => {
  const queryRes = spawnSync('node', [gtPath, 'agent', 'name'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 5000,
  });
  expect(queryRes.status).toBe(0);
  expect(queryRes.stdout).toMatch(/\w+/);

  const setRes = spawnSync('node', [gtPath, 'agent', 'name', 'test-node-x'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 5000,
  });
  expect(setRes.status).toBe(0);
  expect(setRes.stdout).toContain('Agent name set to "test-node-x"');
});

it('rejects removed agent subcommands with exit code 2', () => {
  const runRes = spawnSync('node', [gtPath, 'agent', 'run'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 5000,
  });
  expect(runRes.status).toBe(2);

  const rmRes = spawnSync('node', [gtPath, 'agent', 'rm'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 5000,
  });
  expect(rmRes.status).toBe(2);
});

it('rejects removed config get/set commands with exit code 2', () => {
  const getRes = spawnSync('node', [gtPath, 'config', 'get', 'server'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 5000,
  });
  expect(getRes.status).toBe(2);
});
```

- [ ] **Step 2: Update src/client/index.ts**

1. Under `agent` command in `src/client/index.ts`:
```typescript
const agentCmd = program
  .command('agent')
  .description('Manage local machine reverse agent daemon lifecycle');

agentCmd
  .command('start')
  .description('Start the local agent daemon in background')
  .option('-s, --server <url>', 'Override target Hub URL')
  .option('-k, --key <secret>', 'Override Hub admin secret key')
  .action(async () => {
    const eff = resolveEffective();
    await runAgent(['start'], { server: eff.server, key: eff.key });
  });

agentCmd
  .command('stop')
  .description('Stop the running local agent daemon')
  .action(async () => {
    await runAgent(['stop'], {});
  });

agentCmd
  .command('restart')
  .description('Restart the local agent daemon')
  .option('-s, --server <url>', 'Override target Hub URL')
  .option('-k, --key <secret>', 'Override Hub admin secret key')
  .action(async () => {
    const eff = resolveEffective();
    await runAgent(['restart'], { server: eff.server, key: eff.key });
  });

agentCmd
  .command('status')
  .description('Display local agent daemon running status')
  .action(async () => {
    await runAgent(['status'], {});
  });

agentCmd
  .command('logs')
  .description('View local agent daemon logs')
  .option('-f, --follow', 'Follow log stream')
  .option('-n, --lines <number>', 'Number of lines to show', '50')
  .action(async (opts) => {
    const args = ['logs'];
    if (opts.follow) args.push('-f');
    if (opts.lines) args.push(`-n=${opts.lines}`);
    await runAgent(args, {});
  });

agentCmd
  .command('name [newName]')
  .description('View or set the agent node name for this machine')
  .action((newName) => {
    if (!newName) {
      const res = ConfigStore.resolveAgentName();
      console.log(`${res.name} (${res.source})`);
    } else {
      ConfigStore.setAgentName(newName);
      const updated = ConfigStore.getAgentName();
      console.log(`✓ Agent name set to "${updated}". Run 'gt agent restart' to apply changes if running.`);
    }
  });
```
2. Remove top-level aliases: `run`, `stop`, `restart`, `rm`.
3. In `src/client/commands/config.ts` and `src/client/index.ts`: Remove `gt config get` and `gt config set`. Only keep `get-contexts`, `current-context`, `use-context`, `set-context`, `delete-context`, and `view`.

- [ ] **Step 3: Rebuild gt bundle and run tests**

Run: `npm run build:gt && npx jest tests/gtCommanderCli.test.ts`
Expected: PASS

- [ ] **Step 4: Commit Task 3**

```bash
git add src/client/index.ts src/client/commands/config.ts tests/gtCommanderCli.test.ts
git commit -m "feat(cli): streamline gt agent commands and add gt agent name configuration

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Reconcile Existing Tests to Singleton Model

**Files:**
- Modify: `tests/gtAgentDaemon.test.ts`
- Modify: `tests/terminalAgentConflict.test.ts`
- Modify: `tests/terminalAgent.test.ts`

**Interfaces:**
- Consumes: Singleton agent commands
- Produces: Passing test suites aligned with zero-argument `start`, `stop`, `status`, and `gt agent name`

- [ ] **Step 1: Update test invocations from multi-agent to singleton**

In `tests/gtAgentDaemon.test.ts`:
- Replace any references to `AgentDaemonManager.getAllAgents()` or `gt agent run` with `gt agent start` and `AgentDaemonManager.getStatus()`.
- Update tests verifying start conflict: starting when already running exits with error.

In `tests/terminalAgentConflict.test.ts` and `tests/terminalAgent.test.ts`:
- Ensure tests invoke `node ./dist/gt.js agent start` instead of deprecated `gt run` or `gt agent run`.

- [ ] **Step 2: Rebuild bundle and run full test suite**

Run: `npm run build:gt && npm test`
Expected: All 90+ test suites pass cleanly.

- [ ] **Step 3: Commit Task 4**

```bash
git add tests/
git commit -m "test: align agent test suites with singleton host daemon model

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Documentation Update & Final Ecosystem Verification

**Files:**
- Modify: `README.md`
- Verify: `scripts/deploy.sh`
- Verify: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: Entire project
- Produces: Clean docs, full build verification, end-to-end tests passing

- [ ] **Step 1: Update README.md**

Update the Agent Lifecycle Commands section in `README.md`:
```markdown
### Agent Daemon Commands
```bash
gt agent start           # Start the background reverse agent daemon
gt agent stop            # Stop the running agent daemon
gt agent restart         # Restart the agent daemon
gt agent status          # View daemon status (running/stopped, PID, uptime)
gt agent logs -f         # Follow daemon logs
gt agent name [new-name] # View or configure the persistent agent node name
```
```

- [ ] **Step 2: Run clean build and test verification**

Run:
```bash
npm run clean && npm run build
npm test
```
Expected: 100% test pass, clean build artifacts in `dist/`.

- [ ] **Step 3: Commit Task 5**

```bash
git add README.md
git commit -m "docs: document agent singleton daemon commands and name management in README

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
