# gt CLI Modernization and Context Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Modernize the `gt` CLI using `commander`, introduce a `kubectl`-style multi-context architecture under `gt config` with `default` context auto-initialization, isolate authentication into `gt auth`, cleanly separate remote cluster commands from local agent commands under `gt agent`, and bundle the CLI into a standalone zero-dependency executable via `esbuild`.

**Architecture:** Extend `ConfigStore` with multi-context data structures (`currentContext`, `contexts`, `default` safety fallback). Integrate `commander` into `src/client/index.ts` to replace manual `process.argv` loop parsing. Split commands into clean functional domains (`nodes`, `exec`, `cp`, `task`, `agent`, `auth`, `config`). Ensure `esbuild` bundles `commander` into `dist/gt.js` while maintaining `scripts/gt.js` proxying and standardizing POSIX process exit codes (0, 1, 2, 124, 130).

**Tech Stack:** TypeScript 5.4, Commander.js 12.x, Node.js (18/20), esbuild, Jest 29, ts-jest.

**Spec:** `docs/superpowers/specs/2026-10-09-gt-cli-modernization-and-context-design.md`

## Global Constraints

- Standalone executable (`dist/gt.js`) must run with zero runtime `node_modules` requirements on target systems.
- Multi-context configuration persists in `~/.gt/config.json`.
- `default` context is auto-initialized on first run (`server: "http://localhost:8000"`, `key: ""`).
- `default` context cannot be deleted; `gt config delete-context default` resets it to default settings.
- Deleting an active non-default context automatically resets `currentContext` to `default`.
- Credential resolution precedence: CLI flags (`-s / -k`) > Environment variables (`GT_SERVER / GT_KEY`) > CLI context flag (`-c <context>`) > Active context (`currentContext`) > Default fallback (`http://localhost:8000` / `""`).
- Invalid commands or syntax errors must exit with status code `2`.
- All agent lifecycle operations must be scoped under `gt agent <subcommand>`.

## Review Focus

1. **Default Context Self-Healing**: Loading an empty config or deleted config must self-initialize `currentContext: "default"` with `default` server `http://localhost:8000`.
2. **Context Deletion Fallback**: If active context is `prod` and `gt config delete-context prod` is executed, `currentContext` must revert to `default` rather than becoming undefined.
3. **Commander Flag Forwarding in Exec**: `gt exec -it worker bash -c "ls -la"` must pass `-c "ls -la"` verbatim to the remote command without Commander consuming `-c` as `--context`.
4. **Exit Code 2 on Unknown Commands**: Running `gt non-existent-command` must exit with code `2` rather than `1` or `0`.
5. **Agent Flags Passthrough**: `gt agent run -d -s http://hub:8000 -k secret` must forward credentials and detach the child process cleanly.

---

### Task 1: Add Commander Dependency & ConfigStore Multi-Context Support

**Files:**
- Modify: `package.json`
- Modify: `src/client/config/configStore.ts`
- Create: `tests/gtContextStore.test.ts`

**Interfaces:**
- Consumes: `commander`
- Produces:
  - `ContextConfig`: `{ server: string; key: string }`
  - `ConfigStore.getContexts()`: `Record<string, ContextConfig>`
  - `ConfigStore.getCurrentContext()`: `string`
  - `ConfigStore.useContext(name: string)`: `void`
  - `ConfigStore.setContext(name: string, cfg: Partial<ContextConfig>)`: `void`
  - `ConfigStore.deleteContext(name: string)`: `{ resetDefault?: boolean; deleted?: boolean }`
  - `ConfigStore.getEffectiveConfig({ server?, key?, context? }, env)`: `{ server: string; key: string; context: string }`

- [ ] **Step 1: Install commander dependency**

Run:
```bash
npm install commander
```

- [ ] **Step 2: Write failing unit tests for multi-context ConfigStore**

Create `tests/gtContextStore.test.ts`:
```typescript
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
```

- [ ] **Step 3: Run test to verify failure**

Run: `npx jest tests/gtContextStore.test.ts`
Expected: FAIL (missing methods on ConfigStore)

- [ ] **Step 4: Implement multi-context logic in ConfigStore**

Update `src/client/config/configStore.ts`:
```typescript
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

export const DEFAULT_SERVER_URL = 'http://localhost:8000';

export interface ContextConfig {
  server: string;
  key: string;
}

export interface ConfigData {
  currentContext: string;
  contexts: Record<string, ContextConfig>;
  machineId: string;
  [key: string]: any;
}

export class ConfigStore {
  static getConfigDir(): string {
    return process.env.GT_CONFIG_DIR || path.join(os.homedir(), '.gt');
  }

  static getConfigFile(): string {
    return path.join(this.getConfigDir(), 'config.json');
  }

  static load(): ConfigData {
    let data: any = {};
    try {
      const p = this.getConfigFile();
      if (fs.existsSync(p)) {
        data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      }
    } catch {}

    let needsSave = false;

    if (!data.machineId || typeof data.machineId !== 'string') {
      data.machineId = crypto.randomBytes(6).toString('hex');
      needsSave = true;
    }

    if (!data.contexts || typeof data.contexts !== 'object') {
      data.contexts = {};
      needsSave = true;
    }

    if (!data.contexts.default) {
      data.contexts.default = {
        server: data.server || DEFAULT_SERVER_URL,
        key: data.key || '',
      };
      needsSave = true;
    }

    if (!data.currentContext || !data.contexts[data.currentContext]) {
      data.currentContext = 'default';
      needsSave = true;
    }

    if (needsSave) {
      this.save(data);
    }

    return data as ConfigData;
  }

  static save(data: Record<string, any>): void {
    const dir = this.getConfigDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const file = this.getConfigFile();
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    if (os.platform() !== 'win32') {
      try { fs.chmodSync(file, 0o600); } catch {}
      try { fs.chmodSync(dir, 0o700); } catch {}
    }
  }

  static getMachineId(): string {
    return this.load().machineId;
  }

  static getContexts(): Record<string, ContextConfig> {
    return this.load().contexts;
  }

  static getCurrentContext(): string {
    return this.load().currentContext;
  }

  static useContext(name: string): void {
    const data = this.load();
    if (!data.contexts[name]) {
      throw new Error(`Context '${name}' does not exist.`);
    }
    data.currentContext = name;
    this.save(data);
  }

  static setContext(name: string, cfg: Partial<ContextConfig>): void {
    const data = this.load();
    const existing = data.contexts[name] || { server: DEFAULT_SERVER_URL, key: '' };
    data.contexts[name] = {
      server: cfg.server !== undefined ? cfg.server : existing.server,
      key: cfg.key !== undefined ? cfg.key : existing.key,
    };
    if (!data.currentContext) {
      data.currentContext = name;
    }
    this.save(data);
  }

  static deleteContext(name: string): { resetDefault?: boolean; deleted?: boolean } {
    const data = this.load();
    if (name === 'default') {
      data.contexts.default = { server: DEFAULT_SERVER_URL, key: '' };
      data.currentContext = 'default';
      this.save(data);
      return { resetDefault: true };
    }

    if (!data.contexts[name]) {
      throw new Error(`Context '${name}' does not exist.`);
    }

    delete data.contexts[name];
    if (data.currentContext === name) {
      data.currentContext = 'default';
    }
    this.save(data);
    return { deleted: true };
  }

  static getEffectiveConfig(
    cliOpts: { server?: string; key?: string; context?: string } = {},
    env: Record<string, string | undefined> = process.env
  ): { server: string; key: string; context: string } {
    const data = this.load();
    const targetContextName = cliOpts.context || data.currentContext || 'default';
    const contextConfig = data.contexts[targetContextName] || data.contexts.default || { server: DEFAULT_SERVER_URL, key: '' };

    const server =
      cliOpts.server ||
      env.GT_SERVER ||
      contextConfig.server ||
      DEFAULT_SERVER_URL;

    const key =
      cliOpts.key ||
      env.GT_KEY ||
      contextConfig.key ||
      '';

    return { server, key, context: targetContextName };
  }
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx jest tests/gtContextStore.test.ts`
Expected: PASS

- [ ] **Step 6: Commit Task 1**

```bash
git add package.json package-lock.json src/client/config/configStore.ts tests/gtContextStore.test.ts
git commit -m "feat(config): implement multi-context storage and commander dependency

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Implement `gt config` and `gt auth` CLI Handlers

**Files:**
- Create: `src/client/commands/config.ts`
- Modify: `src/client/commands/auth.ts`
- Create: `tests/gtAuthAndConfigCommands.test.ts`

**Interfaces:**
- Consumes: `ConfigStore`, `makeRequest`
- Produces:
  - `handleConfigGetContexts()`
  - `handleConfigCurrentContext()`
  - `handleConfigUseContext(name: string)`
  - `handleConfigSetContext(name: string, opts: { server?: string; key?: string })`
  - `handleConfigDeleteContext(name: string)`
  - `handleConfigView(raw?: boolean)`
  - `handleAuthLogin({ server, key, context })`
  - `handleAuthStatus({ server, key, context })`
  - `handleAuthLogout(all?: boolean)`

- [ ] **Step 1: Write failing tests for auth & config commands**

Create `tests/gtAuthAndConfigCommands.test.ts`:
```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest tests/gtAuthAndConfigCommands.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement src/client/commands/config.ts**

Create `src/client/commands/config.ts`:
```typescript
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
```

- [ ] **Step 4: Update src/client/commands/auth.ts to support auth login/status/logout**

Update `src/client/commands/auth.ts`:
```typescript
import { ConfigStore } from '../config/configStore';
import { makeRequest } from '../utils/terminalUI';

export async function handleAuthLogin({
  server,
  key,
  context,
}: {
  server?: string;
  key?: string;
  context?: string;
}): Promise<void> {
  const effective = ConfigStore.getEffectiveConfig({ server, key, context });
  const targetServer = effective.server;
  const targetKey = effective.key;
  const targetContext = context || effective.context || 'default';

  try {
    const res = await makeRequest({
      serverUrl: targetServer,
      endpoint: '/api/auth/status',
      method: 'GET',
      apiKey: targetKey,
    });

    if (res.statusCode === 200 || res.data?.authenticated || res.data?.authRequired === false) {
      ConfigStore.setContext(targetContext, {
        server: targetServer,
        key: targetKey,
      });
      ConfigStore.useContext(targetContext);
      console.log(`✓ Successfully authenticated against ${targetServer}`);
      console.log(`Context "${targetContext}" is now active.`);
    } else {
      console.error(`✗ Authentication failed: Invalid secret key for ${targetServer}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`✗ Failed to connect to ${targetServer}: ${err.message}`);
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
    const res = await makeRequest({
      serverUrl: effective.server,
      endpoint: '/api/auth/status',
      method: 'GET',
      apiKey: effective.key,
    });

    if (res.statusCode === 200) {
      console.log(`Connection     : Connected (HTTP 200 OK)`);
    } else {
      console.log(`Connection     : Failed (HTTP ${res.statusCode})`);
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
    console.log('Logged out of all contexts.');
  } else {
    const current = ConfigStore.getCurrentContext();
    ConfigStore.setContext(current, { key: '' });
    console.log(`Logged out of context "${current}".`);
  }
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx jest tests/gtAuthAndConfigCommands.test.ts`
Expected: PASS

- [ ] **Step 6: Commit Task 2**

```bash
git add src/client/commands/config.ts src/client/commands/auth.ts tests/gtAuthAndConfigCommands.test.ts
git commit -m "feat(cli): implement gt config and gt auth command handlers

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Restructure Subcommands & Implement Commander Program

**Files:**
- Create: `src/client/commands/nodes.ts`
- Create: `src/client/commands/task.ts`
- Modify: `src/client/commands/hosts.ts`
- Modify: `src/client/index.ts`
- Create: `tests/gtCommanderCli.test.ts`

**Interfaces:**
- Consumes: `commander`, all handlers from `src/client/commands/`
- Produces: `createProgram(): Command` and `runClient(argv)` using Commander with standard exit codes

- [ ] **Step 1: Write integration tests for Commander CLI commands**

Create `tests/gtCommanderCli.test.ts`:
```typescript
import path from 'path';
import { spawnSync } from 'child_process';

const gtPath = path.resolve(__dirname, '../scripts/gt.js');

describe('gt Commander CLI Structure', () => {
  it('exits with code 2 on unknown command', () => {
    const res = spawnSync('node', [gtPath, 'unknown-xyz'], { encoding: 'utf-8' });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('error: unknown command');
  });

  it('outputs help menu containing nodes, agent, auth, and config command groups', () => {
    const res = spawnSync('node', [gtPath, '--help'], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('nodes');
    expect(res.stdout).toContain('agent');
    expect(res.stdout).toContain('auth');
    expect(res.stdout).toContain('config');
    expect(res.stdout).toContain('exec');
    expect(res.stdout).toContain('cp');
    expect(res.stdout).toContain('task');
  });

  it('supports agent subcommands: run, start, stop, restart, status, logs, prune', () => {
    const res = spawnSync('node', [gtPath, 'agent', '--help'], { encoding: 'utf-8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('run');
    expect(res.stdout).toContain('start');
    expect(res.stdout).toContain('stop');
    expect(res.stdout).toContain('restart');
    expect(res.stdout).toContain('status');
    expect(res.stdout).toContain('logs');
    expect(res.stdout).toContain('prune');
  });
});
```

- [ ] **Step 2: Implement nodes and task command bridges**

Create `src/client/commands/nodes.ts`:
```typescript
import { handleRemotePs, handleRemotePrune } from './hosts';

export async function handleNodesCommand({
  server,
  key,
  all,
  json,
  format,
}: {
  server: string;
  key: string;
  all?: boolean;
  json?: boolean;
  format?: string;
}): Promise<void> {
  const args = all ? ['-a'] : [];
  await handleRemotePs({
    server,
    key,
    args,
    jsonOutput: !!json,
    formatTemplateStr: format || null,
  });
}

export async function handleNodesPruneCommand({
  server,
  key,
  json,
}: {
  server: string;
  key: string;
  json?: boolean;
}): Promise<void> {
  await handleRemotePrune({
    server,
    key,
    args: [],
    jsonOutput: !!json,
  });
}
```

Create `src/client/commands/task.ts`:
```typescript
import { handleRemoteKill } from './manage';
import { handleRemoteLogs } from './logs';
import { handleRemotePs } from './hosts';

export async function handleTaskLs({ server, key, node }: { server: string; key: string; node: string }): Promise<void> {
  console.log(`Tasks on node ${node}:`);
}

export async function handleTaskLogs({
  server,
  key,
  node,
  taskId,
  follow,
}: {
  server: string;
  key: string;
  node: string;
  taskId: string;
  follow?: boolean;
}): Promise<void> {
  await handleRemoteLogs({
    server,
    key,
    node,
    taskId,
    follow: !!follow,
  });
}

export async function handleTaskKill({
  server,
  key,
  node,
  taskId,
}: {
  server: string;
  key: string;
  node: string;
  taskId: string;
}): Promise<void> {
  await handleRemoteKill({
    server,
    key,
    node,
    taskId,
  });
}
```

- [ ] **Step 3: Refactor src/client/index.ts using Commander**

Re-implement `src/client/index.ts` with Commander `Command`, registering:
- Global options (`-c, --context`, `-s, --server`, `-k, --key`, `--json`)
- `gt nodes` (alias `hosts`) and `gt nodes prune`
- `gt exec` with pass-through for remote command args
- `gt cp`
- `gt task <ls|logs|kill>`
- `gt agent <run|start|stop|restart|status|logs|rm|prune>`
- `gt auth <login|status|logout>`
- `gt config <get-contexts|current-context|use-context|set-context|delete-context|view>`
- Configure `program.exitOverride()` so Commander parse errors throw, caught to set `process.exit(2)`.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run build:gt && npx jest tests/gtCommanderCli.test.ts`
Expected: PASS

- [ ] **Step 5: Commit Task 3**

```bash
git add src/client/commands/nodes.ts src/client/commands/task.ts src/client/index.ts tests/gtCommanderCli.test.ts
git commit -m "feat(cli): assemble modern commander CLI with nodes, agent, auth, and config

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Reconcile Existing Tests & Backward Compatibility Updates

**Files:**
- Modify: `tests/gtCli.test.ts`
- Modify: `tests/gtPsCommand.test.ts`
- Modify: `tests/gtAgentDaemon.test.ts`
- Modify: `tests/gtLogsSmartDefault.test.ts`
- Modify: `tests/terminalExecCli.test.ts`

**Interfaces:**
- Consumes: Updated CLI command tree
- Produces: 100% passing test suites updated to modern syntax (`gt nodes`, `gt agent ps`, `gt agent run`)

- [ ] **Step 1: Update test invocations in existing test files**

Update command names in tests:
- `gt ps` (remote) -> `gt nodes` or `gt ps` (if alias maintained)
- `gt run` -> `gt agent run`
- `gt agent ps` -> `gt agent status` (or `gt agent ps` alias)
- `gt prune -l` -> `gt agent prune`

- [ ] **Step 2: Rebuild standalone executable**

Run: `npm run build:gt`
Expected: `dist/gt.js` compiled cleanly.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All 90+ test suites pass cleanly.

- [ ] **Step 4: Commit Task 4**

```bash
git add tests/
git commit -m "test: align test suites with modern gt commander CLI structure

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: Final Build, Validation & Documentation Verification

**Files:**
- Modify: `README.md`
- Verify: `npm run build`
- Verify: `npm test`

**Interfaces:**
- Consumes: Entire project
- Produces: Complete, verified modern CLI with updated README documentation

- [ ] **Step 1: Update README.md with modern CLI usage**

Update CLI section in `README.md`:
- Document `gt auth login`
- Document `gt nodes`, `gt exec`, `gt cp`, `gt task`
- Document `gt agent run`, `gt agent status`
- Document `gt config use-context`

- [ ] **Step 2: Full clean build**

Run: `npm run clean && npm run build`
Expected: Frontend, backend, and standalone `dist/gt.js` built successfully.

- [ ] **Step 3: Full test suite verification**

Run: `npm test`
Expected: 100% pass across all tests.

- [ ] **Step 4: Commit Task 5**

```bash
git add README.md
git commit -m "docs: update README with modern gt CLI commands and context workflows

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
