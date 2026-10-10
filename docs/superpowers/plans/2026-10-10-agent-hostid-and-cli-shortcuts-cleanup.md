# Agent HostId Machine Identity and CLI Shortcuts Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify Agent registration `hostId` to strictly equal the machine's `machineId` (removing the `${machineId}-${hostName}` suffix), retain `gt ps` strictly for remote node listing, and completely remove redundant shortcuts/aliases (`hosts` alias, `host`, `kill`, `logs`, `prune`).

**Architecture:** In `src/agent/daemon.ts`, assign `hostId` directly to `machineId` without checking or appending node names. In `src/client/index.ts`, remove the `.alias('hosts')` from `nodes`, remove the `host` command group, remove the top-level `kill`, `logs`, and `prune` commands, and simplify `gt ps` to delegate directly to `handleNodesCommand` without local agent branching.

**Tech Stack:** TypeScript 5.4, Commander.js 12.x, esbuild, Jest 29, ts-jest.

**Spec:** `docs/superpowers/specs/2026-10-10-agent-hostid-and-cli-shortcuts-cleanup-design.md`

## Global Constraints

- Agent registration `hostId` must equal `machineId` unless an explicit `id` option was passed.
- `gt ps` is preserved strictly as a remote nodes listing shortcut (`gt nodes`), without `-l, --local` options.
- `gt host`, `gt kill`, `gt logs`, `gt prune`, and `gt hosts` must be rejected with exit code 2 (Commander unknown command).
- Standalone bundle (`dist/gt.js`) must rebuild cleanly via `npm run build:gt`.

## Review Focus

1. **HostId Purity**: Even when `ConfigStore.setAgentName('custom-name')` is configured, the agent's registered `hostId` must equal `ConfigStore.getMachineId()` directly without `-custom-name`.
2. **`gt ps` Remote Behavior**: Running `gt ps` must call `handleRemotePs` (or `handleNodesCommand`) to list remote nodes, and not have any local agent branch.
3. **Rejection of Removed Shortcuts**: `gt host`, `gt kill`, `gt logs`, `gt prune`, `gt hosts` must exit with code 2.
4. **Full Test Regression**: All 96 existing test suites must pass after removing obsolete shortcuts.

---

### Task 1: Simplify Agent Registration HostId to MachineId

**Files:**
- Modify: `src/agent/daemon.ts`
- Modify: `tests/gtAgentDaemon.test.ts`

**Interfaces:**
- Consumes: `ConfigStore.getMachineId()`
- Produces: `hostId = options.id || options.hostId || machineId`

- [ ] **Step 1: Write unit test in tests/gtAgentDaemon.test.ts for clean hostId**

Add a test in `tests/gtAgentDaemon.test.ts`:
```typescript
it('assigns hostId strictly as machineId without appending agentName', () => {
  process.env.GT_CONFIG_DIR = testConfigDir;
  const { ConfigStore } = require('../scripts/gt.js');
  ConfigStore.setAgentName('my-custom-node');
  const machineId = ConfigStore.getMachineId();

  // Inspect the resolved hostId logic
  const resolvedHostId = ConfigStore.getMachineId();
  expect(resolvedHostId).toBe(machineId);
  expect(resolvedHostId).not.toContain('my-custom-node');
});
```

- [ ] **Step 2: Update hostId resolution in src/agent/daemon.ts**

In `src/agent/daemon.ts` around line 398:
```typescript
  const machineId = ConfigStore.getMachineId();
  const hostId = options.id || options.hostId || machineId;
```
Remove the old conditional:
```typescript
  // REMOVE:
  // if (hostName === defaultHostname) {
  //   hostId = machineId;
  // } else {
  //   hostId = `${machineId}-${hostName}`;
  // }
```

- [ ] **Step 3: Run test to verify it passes**

Run: `npx jest tests/gtAgentDaemon.test.ts`
Expected: PASS

- [ ] **Step 4: Commit Task 1**

```bash
git add src/agent/daemon.ts tests/gtAgentDaemon.test.ts
git commit -m "refactor(agent): ensure registered hostId strictly equals machineId without name suffix

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: Remove Redundant Top-Level Commands and Simplify `gt ps`

**Files:**
- Modify: `src/client/index.ts`
- Modify: `tests/gtCommanderCli.test.ts`
- Modify: `tests/gtPsCommand.test.ts`

**Interfaces:**
- Consumes: `handleNodesCommand`
- Produces: Streamlined Commander program with `gt ps` preserved, and `hosts`, `host`, `kill`, `logs`, `prune` removed

- [ ] **Step 1: Update tests/gtCommanderCli.test.ts to verify command removals and gt ps preservation**

In `tests/gtCommanderCli.test.ts`:
```typescript
it('preserves gt ps as a remote node listing command', () => {
  const res = spawnSync('node', [gtPath, 'ps', '--help'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    timeout: 5000,
  });
  expect(res.status).toBe(0);
  expect(res.stdout).toContain('List connected hosts');
  expect(res.stdout).not.toContain('--local');
});

it('rejects removed top-level shortcut commands with exit code 2', () => {
  for (const cmd of ['host', 'hosts', 'kill', 'logs', 'prune']) {
    const res = spawnSync('node', [gtPath, cmd], {
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 5000,
    });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('error: unknown command');
  }
});
```

- [ ] **Step 2: Remove aliases and shortcut commands from src/client/index.ts**

1. Remove `.alias('hosts')` from `nodesCmd`.
2. Remove the entire `hostCmd` definition (lines ~155-196).
3. Update `gt ps` definition:
```typescript
  // Simplified gt ps (strictly remote nodes)
  program
    .command('ps')
    .description('List connected hosts on the target Hub')
    .option('-a, --all', 'Include offline hosts')
    .option('-s, --server <url>', 'Hub server URL')
    .option('-k, --key <secret>', 'Admin secret key')
    .option('-c, --context <name>', 'Target context')
    .option('--json', 'Output in JSON format')
    .option('--format <template>', 'Format output template')
    .action(async (opts: Record<string, any>) => {
      const eff = resolveEffective(opts);
      await handleRemotePs({
        server: eff.server,
        key: eff.key,
        args: opts.all ? ['-a'] : [],
        jsonOutput: resolveJson(opts),
        formatTemplateStr: resolveFormat(opts),
      });
    });
```
4. Remove top-level `prune` command (lines ~224-257).
5. Remove top-level `kill` command (lines ~413-425).
6. Remove top-level `logs` command (lines ~427-444).
7. Clean up `printHelp()` text in `src/client/index.ts`: remove `kill`, `logs`, `prune`, `host` shortcuts, keeping `gt ps` and remote execution shortcuts.

- [ ] **Step 3: Run Commander CLI tests**

Run: `npm run build:gt && npx jest tests/gtCommanderCli.test.ts`
Expected: PASS

- [ ] **Step 4: Commit Task 2**

```bash
git add src/client/index.ts tests/gtCommanderCli.test.ts tests/gtPsCommand.test.ts
git commit -m "refactor(cli): remove redundant shortcuts host, kill, logs, prune and retain gt ps

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: Test Reconciliation, Documentation & Build Verification

**Files:**
- Modify: `README.md`
- Verify: Full test suite

**Interfaces:**
- Consumes: Streamlined CLI commands
- Produces: 100% passing test suites, updated README documentation

- [ ] **Step 1: Update README.md to remove deleted shortcut commands**

In `README.md`, update references:
- Change `gt kill <node> <taskId>` to `gt task kill <node> <taskId>`
- Remove references to `gt host`, `gt logs`, `gt prune` (point to `gt task logs`, `gt agent logs`, `gt nodes prune`)
- Keep `gt ps` as remote node listing shortcut.

- [ ] **Step 2: Run full build and test suite**

Run:
```bash
npm run clean && npm run build
npm test
```
Expected: All test suites pass.

- [ ] **Step 3: Commit Task 3**

```bash
git add README.md
git commit -m "docs: update README to remove deprecated top-level shortcut commands

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
