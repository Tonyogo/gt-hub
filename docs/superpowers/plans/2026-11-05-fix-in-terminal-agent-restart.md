# Fix In-Terminal `gt agent restart` Self-Termination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the bug where running `gt agent restart` (or version auto-upgrade via `gt agent start`) inside the agent's own Web Terminal or `gt exec` session kills the `gt agent restart` CLI process mid-stop before it can spawn the new daemon, leaving the node offline and the terminal disconnected.

**Architecture:**
1. Decouple daemon spawning from old-daemon termination during `gt agent restart` and version auto-upgrade in `src/agent/daemon.ts`: instead of calling `await AgentDaemonManager.stop()` in the foreground CLI process (which is a child of the old daemon's PTY shell and gets killed by `SIGTERM`/`SIGKILL` when the old daemon tears down its PTY), the CLI first validates config, spawns the new `--internal-daemon` with `detached: true` (`setsid()`) and `GT_REPLACE_PID=<oldPid>`, updates `agent.json` with the new PID, prints the startup confirmation, and exits `0` immediately.
2. Perform the old-daemon stop handover (`AgentDaemonManager.terminatePid(replacePid)`) inside the newly spawned `--internal-daemon` process (which runs in an independent session/process group via `detached: true` and is immune to the old PTY's teardown) before it spawns its own PTY and connects to the Hub.

**Tech Stack:** Node.js (`child_process`, POSIX signals), TypeScript, Jest.

**Spec:** In-chat approved design (2026-11-05).

## Global Constraints

- Preserve exact CLI stdout messages (`Agent started in background (PID: ...)` and `Upgrading to current CLI version`) and exit codes expected by `tests/gtAgentDaemon.test.ts` and `scripts/install-gt.sh`.
- Ensure `gt agent stop` still synchronously stops the running daemon and clears `agent.json`.
- Always run targeted Jest tests via `npm test -- tests/<file>.test.ts`.

## Review Focus

- When `gt agent restart` is executed as a child process inside a simulated PTY shell process group that sends `SIGKILL` to its entire process group upon receiving `SIGTERM` from the old daemon (matching `PosixPtyDriver` behavior on Linux), `gt agent restart` must exit `0` with its normal stdout output, the old daemon must be terminated, and the new daemon must remain alive and recorded in `agent.json`.
- When the old daemon receives `SIGTERM` during handover, it must not delete `agent.json` because `agent.json` already contains the new daemon's PID (`s.pid !== process.pid`).
- If `gt agent stop` is invoked immediately after `gt agent restart` while the new daemon is still in the handover phase waiting for `replacePid` to exit, the new daemon must also terminate `replacePid` before exiting so no orphan daemon process is left behind.
- Credential validation (`!serverArg || !adminKey`) must run before stopping or replacing any running daemon.

---

### Task 1: Hand Over Old Daemon Termination to Detached New Daemon on `restart` and Auto-Upgrade

**Files:**
- Modify: `src/agent/daemon.ts:147-170,464-620`
- Modify: `tests/gtAgentDaemon.test.ts`

**Interfaces:**
- Produces:
  - `AgentDaemonManager.terminatePid(pid: number, timeoutMs?: number): Promise<void>` in `src/agent/daemon.ts`: sends `SIGTERM` to `pid`, polls `isProcessAlive(pid)` up to `timeoutMs` (default `3000` ms), and falls back to `killProcessTreeSync(pid, 'SIGKILL')` without calling `clearStatus()`.
  - `GT_REPLACE_PID` handover in `runAgent` (`src/agent/daemon.ts`).

- [x] **Step 1: Write failing test in `tests/gtAgentDaemon.test.ts` simulating `gt agent restart` inside an old daemon's PTY process group**

Add a test in `tests/gtAgentDaemon.test.ts` where a mock "old daemon" process spawns a child process group on `SIGTERM` (just like `PosixPtyDriver` killing its shell process group with `SIGKILL` when the daemon receives `SIGTERM`), and `gt agent restart` is executed inside that child process group:

```ts
  it('completes gt agent restart and keeps new daemon alive even when executed inside old daemon PTY that SIGKILLs its process group on SIGTERM', async () => {
    fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify({
      server: 'http://127.0.0.1:3000',
      key: 'mock-key',
      agentName: 'in-pty-restart-node',
    }));

    const { AgentDaemonManager, getVersionInfo } = require('../scripts/gt.js');
    process.env.GT_CONFIG_DIR = testConfigDir;

    // Simulate an old daemon that spawns a PTY shell and, upon receiving SIGTERM,
    // immediately sends SIGKILL to the shell's process group (matching PosixPtyDriver cleanup).
    const oldDaemonScript = `
      const { spawn } = require('child_process');
      let shellPid = null;
      process.on('SIGTERM', () => {
        if (shellPid) {
          try { process.kill(-shellPid, 'SIGKILL'); } catch {}
          try { process.kill(shellPid, 'SIGKILL'); } catch {}
        }
        setTimeout(() => process.exit(0), 200);
      });
      setInterval(() => {}, 1000);
    `;
    const oldDaemon = spawn(process.execPath, ['-e', oldDaemonScript], {
      detached: true,
      stdio: 'ignore',
    });
    oldDaemon.unref();

    AgentDaemonManager.saveStatus({
      pid: oldDaemon.pid,
      name: 'in-pty-restart-node',
      server: 'http://127.0.0.1:3000',
      version: getVersionInfo().version,
    });

    try {
      // Run `gt agent restart` in the same process group as a child that oldDaemon would kill if signaled before exit
      const runnerScript = `
        const { spawnSync } = require('child_process');
        process.on('SIGTERM', () => process.exit(143));
        const res = spawnSync(process.execPath, [${JSON.stringify(gtPath)}, 'agent', 'restart'], {
          env: process.env,
          encoding: 'utf-8',
        });
        process.stdout.write(res.stdout || '');
        process.stderr.write(res.stderr || '');
        process.exit(res.status ?? 1);
      `;

      // Also wire oldDaemon to kill this runner if oldDaemon receives SIGTERM while runner is still alive
      const killerGuard = spawn(process.execPath, ['-e', `
        const targetOld = ${oldDaemon.pid};
        const { spawn } = require('child_process');
        const runner = spawn(process.execPath, ['-e', ${JSON.stringify(runnerScript)}], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        });
        let out = '';
        runner.stdout.on('data', d => out += d.toString());
        runner.stderr.on('data', d => out += d.toString());
        // Poll oldDaemon; the moment oldDaemon receives SIGTERM / dies, SIGKILL the runner process group (simulating PTY teardown)
        const timer = setInterval(() => {
          try {
            process.kill(targetOld, 0);
          } catch {
            clearInterval(timer);
            try { process.kill(-runner.pid, 'SIGKILL'); } catch {}
          }
        }, 10);
        runner.on('close', (code) => {
          clearInterval(timer);
          console.log('RUNNER_EXIT=' + code);
          console.log(out);
          process.exit(0);
        });
      `], {
        env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let guardOut = '';
      killerGuard.stdout.on('data', (d) => { guardOut += d.toString(); });
      await new Promise<void>((resolve) => killerGuard.on('close', () => resolve()));

      expect(guardOut).toContain('RUNNER_EXIT=0');
      expect(guardOut).toContain('Agent started in background (PID:');

      // Wait for handover to complete (oldDaemon should be dead, new daemon should be alive)
      const waitStart = Date.now();
      while (Date.now() - waitStart < 4000) {
        if (!AgentDaemonManager.isProcessAlive(oldDaemon.pid)) break;
        await new Promise((r) => setTimeout(r, 50));
      }

      expect(AgentDaemonManager.isProcessAlive(oldDaemon.pid)).toBe(false);
      const newStatus = AgentDaemonManager.getStatus();
      expect(newStatus.running).toBe(true);
      expect(newStatus.pid).not.toBe(oldDaemon.pid);
    } finally {
      try { if (oldDaemon.pid) process.kill(oldDaemon.pid, 'SIGKILL'); } catch {}
      spawnSync('node', [gtPath, 'agent', 'stop'], {
        env: { ...process.env, GT_CONFIG_DIR: testConfigDir },
        encoding: 'utf-8',
        timeout: 5000,
      });
    }
  });
```

- [x] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/gtAgentDaemon.test.ts -t "completes gt agent restart and keeps new daemon alive"`
Expected: FAIL (`RUNNER_EXIT=null` or `RUNNER_EXIT=143` because `oldDaemon` dies during `await AgentDaemonManager.stop()` before `gt agent restart` spawns the new daemon)

- [x] **Step 3: Implement `AgentDaemonManager.terminatePid` and detached handover in `src/agent/daemon.ts`**

1. Add `static async terminatePid(pid: number, timeoutMs: number = 3000): Promise<boolean>` to `AgentDaemonManager`:
   ```ts
   static async terminatePid(pid: number, timeoutMs: number = 3000): Promise<boolean> {
     if (!this.isProcessAlive(pid)) return true;
     try { process.kill(pid, 'SIGTERM'); } catch {}
     const start = Date.now();
     while (Date.now() - start < timeoutMs) {
       if (!this.isProcessAlive(pid)) {
         return true;
       }
       await new Promise(r => setTimeout(r, 50));
     }
     killProcessTreeSync(pid, 'SIGKILL');
     return false;
   }
   ```
   Update `AgentDaemonManager.stop()` to use `terminatePid(pid, 3000)` and `this.clearStatus()`.
2. In `runAgent` (`src/agent/daemon.ts`):
   - Resolve `effectiveConfig` (`serverArg`, `adminKey`) and validate `if (!serverArg || !adminKey)` before checking or stopping any running daemon.
   - Track `let replacePid: number | null = null;`.
   - When `!isInternalDaemon`:
     - If `subCmd === 'restart'`:
       - If `current && current.running && current.pid`:
         - If `isDaemon`, set `replacePid = current.pid;` (do NOT call `await AgentDaemonManager.stop()` in the foreground CLI!).
         - Otherwise call `await AgentDaemonManager.stop();`.
     - Else if `current && current.running && current.pid`:
       - If `!current.version || current.version !== currentCliVersion`:
         - Print `[Agent] Active agent daemon is running outdated version (${oldVer}). Upgrading to current CLI version (${currentCliVersion})...`.
         - If `isDaemon`, set `replacePid = current.pid;`.
         - Otherwise call `await AgentDaemonManager.stop();`.
       - Else print `Error: Agent daemon is already running...` and `process.exit(1)`.
   - When spawning the background daemon (`if (isDaemon && !isInternalDaemon)`):
     - Pass `...(replacePid ? { GT_REPLACE_PID: String(replacePid) } : {})` in `env` of `spawn(...)`.
     - Save new status with `pid: child.pid` immediately via `AgentDaemonManager.saveStatus(...)`.
     - Print `Agent started in background...` and call `process.exit(0)`.
   - When `isInternalDaemon` starts:
     - Check `const envReplacePid = process.env.GT_REPLACE_PID ? parseInt(process.env.GT_REPLACE_PID, 10) : 0;`.
     - If `envReplacePid > 0 && envReplacePid !== process.pid && AgentDaemonManager.isProcessAlive(envReplacePid)`:
       - Register a temporary signal hook so if this new daemon receives `SIGTERM`/`SIGINT` during handover, it also kills `envReplacePid`.
       - Wait 50ms (`await new Promise(r => setTimeout(r, 50))`) so the parent CLI process can flush stdout and exit cleanly before the old daemon's PTY is torn down.
       - Call `await AgentDaemonManager.terminatePid(envReplacePid, 3000);`.
       - Re-verify `agent.json` still has `pid: process.pid` (if the old daemon was a legacy binary that unlinked `agent.json` unconditionally on exit, re-save status for `process.pid`).

- [x] **Step 4: Run tests and full build**

Run: `npm test -- tests/gtAgentDaemon.test.ts tests/terminalAgentConflict.test.ts && npm run build`
Expected: PASS on all tests and build succeeds.

- [x] **Step 5: Commit**

```bash
git add src/agent/daemon.ts tests/gtAgentDaemon.test.ts docs/superpowers/plans/2026-11-05-fix-in-terminal-agent-restart.md
git commit -m "fix(agent): spawn detached daemon before terminating old daemon on restart"
```
