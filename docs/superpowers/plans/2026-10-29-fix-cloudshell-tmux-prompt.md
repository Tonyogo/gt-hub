# Fix Split-Pane Extra `cloudshell` Prompt Text (TMUX Env Leak) Plan

**Goal:** Eliminate the extra `cloudshell` text (`xxxxx@cloudshell:~$ cloudshell`) appearing after the shell prompt in split-pane terminals on Linux / Google Cloud Shell hosts.

**Root Cause:** When `gt agent` is started inside a `tmux` session on Linux / Cloud Shell, `process.env.TMUX` is inherited by the agent daemon. While the primary PTY in `daemon.ts` explicitly deletes `TMUX`, `TMUX_PANE`, `STY`, `WINDOW`, and `TERM_SESSION_ID`, `StreamSessionManager.startStream` and `RemoteAgentTerminalSession.ensurePaneStreamStarted` did not unset `TMUX`. On Google Cloud Shell (`/google/devshell/bashrc.google` line 142), `if [[ -n $TMUX ]]; then export PS1+='\[\033k...cloudshell\033\\\]'; fi` appends a `screen`/`tmux`-specific title sequence `\033kcloudshell\033\\` to `PS1`. Because `xterm.js` is not `tmux`, `\033k` is ignored and `cloudshell` is printed literally after every prompt!

---

### Task 1: Unset Multiplexer Env Vars (`TMUX`, `STY`, etc.) in Hub Split-Pane Stream & Agent `StreamSessionManager`

**Files:**
- Modify: `src/terminal/services/terminalHostManager.ts:104-130`
- Modify: `src/agent/pty/sessionManager.ts:63-75`
- Test: `tests/terminalSplitPaneHub.test.ts`

- [x] **Step 1: Update `ensurePaneStreamStarted` in `src/terminal/services/terminalHostManager.ts`**

In `src/terminal/services/terminalHostManager.ts`:
Update `ensurePaneStreamStarted` so that:
1. `command` explicitly unsets multiplexer variables before `exec`:
   `'unset TMUX TMUX_PANE STY WINDOW TERM_SESSION_ID GOOGLE_BASHRC_SOURCED; exec "${SHELL:-/bin/sh}" -l'`
2. `env` explicitly clears them as well:
   ```ts
   env: {
     TMUX: '',
     TMUX_PANE: '',
     STY: '',
     WINDOW: '',
     TERM_SESSION_ID: '',
   },
   ```

- [x] **Step 2: Clean inherited multiplexer env vars in `src/agent/pty/sessionManager.ts`**

In `src/agent/pty/sessionManager.ts` (`startStream`):
After constructing `taskEnv`, delete `TMUX`, `TMUX_PANE`, `STY`, `WINDOW`, and `TERM_SESSION_ID` unless explicitly provided in `env` with a non-empty value:
```ts
    if (!env.TMUX) delete taskEnv.TMUX;
    if (!env.TMUX_PANE) delete taskEnv.TMUX_PANE;
    if (!env.STY) delete taskEnv.STY;
    if (!env.WINDOW) delete taskEnv.WINDOW;
    if (!env.TERM_SESSION_ID) delete taskEnv.TERM_SESSION_ID;
```

- [x] **Step 3: Add unit test assertion in `tests/terminalSplitPaneHub.test.ts`**

In `tests/terminalSplitPaneHub.test.ts`:
Verify that the `start_stream` command sent for the `'split'` pane contains `unset TMUX` and passes `env` clearing `TMUX` so that `bashrc.google` on Cloud Shell never emits `\033kcloudshell\033\\`.

- [x] **Step 4: Run targeted tests and full build**

Run:
- `npm test -- tests/terminalSplitPaneHub.test.ts tests/terminalSplitPaneWs.test.ts tests/gtAgentStream.test.ts`
- `npm run build`
