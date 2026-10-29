# Fix Split-Pane Legacy Agent Compatibility & CI Failure Plan

**Goal:** Fix the CI failure in `tests/terminalNonFullscreenStability.test.ts` and fix the split-pane terminal protocol so that secondary panes (`paneId !== 'main'`) use the Agent's universal `cmd_exec` stream protocol (`start_stream`, `cmd_stream_input`, `cmd_stream_resize`, `cmd_stream_kill`, `STREAM_OUTPUT` / `cmd_stream_data` / `cmd_stream_exit`), working seamlessly with both deployed/existing agents and new agents without ever leaking `"split"` binary headers into the primary terminal.

---

### Task 1: Fix CI Failure in `UnifiedTerminalView.tsx` (`tests/terminalNonFullscreenStability.test.ts`)

**Files:**
- Modify: `frontend/src/components/UnifiedTerminalView.tsx:480-495`
- Test: `tests/terminalNonFullscreenStability.test.ts`

- [ ] **Step 1: Update `useEffect` in `frontend/src/components/UnifiedTerminalView.tsx`**

Restore the exact `useEffect` structure expected by `tests/terminalNonFullscreenStability.test.ts` while still fitting `splitTerminalRef`:
```tsx
  useEffect(() => {
    if (subTab === 'interactive' && activeHostId) {
      const t1 = setTimeout(() => {
        terminalRef.current?.fit(true);
        splitTerminalRef.current?.fit(true);
      }, 60);
      const t2 = setTimeout(() => {
        terminalRef.current?.fit();
        splitTerminalRef.current?.fit();
      }, 200);
      const t3 = setTimeout(() => {
        terminalRef.current?.fit();
        splitTerminalRef.current?.fit();
      }, 500);
      return () => {
        clearTimeout(t1);
        clearTimeout(t2);
        clearTimeout(t3);
      };
    }
  }, [subTab, activeHostId]);
```

- [ ] **Step 2: Run `npm test -- tests/terminalNonFullscreenStability.test.ts`**
Expected: PASS.

---

### Task 2: Switch Secondary Pane Hub Protocol to Universal `cmd_exec` Stream Protocol

**Why:** Deployed agents on remote hosts do not recognize `BIN_MSG_TYPE.TERMINAL_RAW (0x03)` on the raw agent WebSocket and fall through to `ptyProcess.write(data.toString())`, which writes `\x03\x05split<input>` directly into the primary terminal! However, ALL deployed agents already support `cmd_exec` (`action: 'start_stream'`), `cmd_stream_input`, `cmd_stream_resize`, `cmd_stream_kill`, `STREAM_OUTPUT (0x02)`, `cmd_stream_data`, and `cmd_stream_exit`.

**Files:**
- Modify: `src/terminal/services/terminalHostManager.ts`
- Modify: `src/terminal/routes/terminalWs.ts`
- Test: `tests/terminalSplitPaneHub.test.ts`
- Test: `tests/terminalSplitPaneWs.test.ts`

- [ ] **Step 1: Update `RemoteAgentTerminalSession` in `src/terminal/services/terminalHostManager.ts` for `paneId !== 'main'`**

In `RemoteAgentTerminalSession`:
- Add `private streamStarted: boolean = false;` and helper `public getStreamTaskId(): string { return `pane-${this.paneId}`; }`.
- Add `private ensurePaneStreamStarted(cols?: number, rows?: number): void`:
  - Only runs when `this.paneId !== 'main'`, `!this.streamStarted`, and `this.agentWs && this.agentWs.readyState === 1`.
  - Sets `this.streamStarted = true`.
  - Sends `JSON:${JSON.stringify({ type: 'cmd_exec', action: 'start_stream', taskId: this.getStreamTaskId(), command: 'exec "${SHELL:-/bin/sh}" -l', tty: true, interactive: true, cols: cols || this.currentCols || 80, rows: rows || this.currentRows || 24 })}`.
- In `updateAgentWs(agentWs)`:
  - Reset `this.streamStarted = false;` so if the agent reconnects while a secondary pane has active browser sockets, `ensurePaneStreamStarted` will re-open the stream.
- In `attach(ws)`:
  - When `this.paneId !== 'main'`, if `this.history.getSize() === 0 && this.agentWs && this.agentWs.readyState === 1`, call `this.ensurePaneStreamStarted()`.
- In `write(data: string)`:
  - When `this.paneId === 'main'`, keep existing raw string write.
  - When `this.paneId !== 'main'`:
    - Call `this.ensurePaneStreamStarted()`.
    - Build `const payload = `JSON:${JSON.stringify({ type: 'cmd_stream_input', taskId: this.getStreamTaskId(), data: Buffer.from(data, 'utf-8').toString('base64') })}`;`.
    - Send `payload` over `this.agentWs` (or buffer in `this.pendingInputBuffer` if offline).
- In `resize(cols, rows, force)`:
  - When `this.paneId !== 'main'`:
    - Call `this.ensurePaneStreamStarted(cols, rows)`.
    - Send `JSON:${JSON.stringify({ type: 'cmd_stream_resize', taskId: this.getStreamTaskId(), cols, rows })}` (including nudge when `shouldNudge` is true).
- In `reset(notifyClients, resetAgentPty)`:
  - When `this.paneId !== 'main'` and `resetAgentPty`:
    - If `this.agentWs && this.agentWs.readyState === 1`, send `JSON:${JSON.stringify({ type: 'cmd_stream_kill', taskId: this.getStreamTaskId(), signal: 'SIGTERM' })}`.
    - Set `this.streamStarted = false;` and immediately call `this.ensurePaneStreamStarted(prevCols || 80, prevRows || 24)` so the reset pane spawns a fresh shell.
- In `TerminalHostManager.destroyPaneSession(hostIdOrName, paneId, notifyAgent = true)`:
  - If `notifyAgent` and `agentWs && agentWs.readyState === 1`, send `JSON:${JSON.stringify({ type: 'cmd_stream_kill', taskId: `pane-${normalizedPaneId}`, signal: 'SIGTERM' })}`.

- [ ] **Step 2: Route `pane-<paneId>` stream outputs and exits in `src/terminal/routes/terminalWs.ts`**

In `src/terminal/routes/terminalWs.ts` inside `agentWss.on('connection')`:
- Binary `BIN_MSG_TYPE.STREAM_OUTPUT`:
  ```ts
  if (decoded && decoded.msgType === BIN_MSG_TYPE.STREAM_OUTPUT) {
    if (decoded.id && decoded.id.startsWith('pane-')) {
      const paneId = decoded.id.slice(5);
      hostMgr.handleAgentPaneData(hostId, paneId, decoded.payload);
      return;
    }
    terminalExecBridge.handleAgentStreamMessage(hostId, buf);
    return;
  }
  ```
- JSON `cmd_stream_data` / `cmd_stream_exit`:
  ```ts
  if (control.type === 'cmd_stream_data' || control.type === 'cmd_stream_exit') {
    if (typeof control.taskId === 'string' && control.taskId.startsWith('pane-')) {
      const paneId = control.taskId.slice(5);
      if (control.type === 'cmd_stream_data' && control.data) {
        hostMgr.handleAgentPaneData(hostId, paneId, Buffer.from(control.data, 'base64'));
      } else if (control.type === 'cmd_stream_exit') {
        hostMgr.handleAgentPaneExit(hostId, paneId, control.exitCode);
      }
      return;
    }
    terminalExecBridge.handleAgentStreamMessage(hostId, control);
    return;
  }
  ```
- Keep `BIN_MSG_TYPE.TERMINAL_RAW` and `control.type === 'pane_exit'` handlers in `terminalWs.ts` as well for compatibility.

- [ ] **Step 3: Update `tests/terminalSplitPaneHub.test.ts` and `tests/terminalSplitPaneWs.test.ts` to assert universal `cmd_exec` stream messages**

Update both test files to verify:
1. `splitSession.resize(60, 40)` sends `cmd_exec` (`action: 'start_stream'`, `taskId: 'pane-split'`) and `cmd_stream_resize` (`taskId: 'pane-split'`, `cols: 60`, `rows: 40`).
2. `splitSession.write('pwd\r')` sends `JSON:{"type":"cmd_stream_input","taskId":"pane-split","data":"cHdkDQ=="}` and NEVER sends raw binary `0x03` frames that an older agent would dump into the main PTY.
3. `destroyPaneSession(hostId, 'split', true)` sends `JSON:{"type":"cmd_stream_kill","taskId":"pane-split","signal":"SIGTERM"}`.
4. Inbound `STREAM_OUTPUT` binary packets (with `id = 'pane-split'`) and `cmd_stream_data` / `cmd_stream_exit` (with `taskId = 'pane-split'`) route exclusively to the `'split'` session and never leak into `'main'`.

- [ ] **Step 4: Run targeted tests and build**

Run:
- `npm test -- tests/terminalNonFullscreenStability.test.ts tests/terminalSplitPaneHub.test.ts tests/terminalSplitPaneWs.test.ts tests/frontendSplitPaneWorkspace.test.ts`
- `npm run build`
