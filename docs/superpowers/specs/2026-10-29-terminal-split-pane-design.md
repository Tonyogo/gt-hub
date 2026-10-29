# Web Terminal Split-Pane (Left/Right) Design Spec

- **Date**: 2026-10-29
- **Status**: Draft (Pending User Review)
- **Scope**: Frontend (`UnifiedTerminalView`, `WebTerminalView`), Hub Server (`TerminalHostManager`, `terminalWs`), and Reverse Agent (`daemon.ts`).

---

## 1. Overview & Goals

Enable iTerm2-style left/right split-pane functionality in the interactive web terminal (`UnifiedTerminalView`).

### Key Objectives
1. **Same-Host Independent Shell Sessions**: Both left (`main`) and right (`split`) panes connect to the currently selected host (`activeHostId`), each backed by its own independent shell/PTY process, scrollback history buffer, and terminal dimensions (`cols × rows`).
2. **Smooth Split Layout & Resizing**:
   - Toggleable left/right split layout (default `50% : 50%` width ratio).
   - Draggable vertical divider (`20%` to `80%` clamping) with double-click reset to `50% : 50%`.
   - Active pane focus tracking with visual focus indicator and keyboard shortcuts.
3. **iTerm2-Style Session Lifecycle**:
   - **Persistent While Open**: While the split pane is open, browser refreshes or transient network reconnects preserve and replay both panes' scrollback histories and running processes.
   - **Destroy on Close / Exit**: Closing the split pane via UI/shortcut or typing `exit` inside the split shell terminates the `split` PTY process on the agent, clears its history buffer on both Agent and Hub, and collapses the UI back to a single pane.

---

## 2. Frontend Architecture & UI Design

### 2.1 State Management in `UnifiedTerminalView.tsx`
- `isSplitMode: boolean`: Persisted per host in `localStorage` (`terminal_split_mode_${activeHostId}` or global `terminal_split_enabled`) so refreshing the page restores the split view.
- `splitRatio: number`: Percentage width of the left pane (`20` to `80`, default `50`), persisted in `localStorage` (`terminal_split_ratio`).
- `activePane: 'main' | 'split'`: Tracks which pane currently has focus (defaults to `'main'`; switches to `'split'` when opening the split pane).
- `mainTerminalRef` and `splitTerminalRef`: Separate `WebTerminalHandle` refs for the two `WebTerminalView` instances.

### 2.2 Toolbar & Keyboard Shortcuts
- **Top Toolbar Button**:
  - In `subTab === 'interactive'`, add a split-pane toggle button (`Columns2` icon from `lucide-react`).
  - Clicking when `isSplitMode === false` opens the right split pane (`isSplitMode = true`, `activePane = 'split'`).
  - Clicking when `isSplitMode === true` closes the right split pane (`closeSplitPane()`), terminating the secondary PTY session and returning focus to `'main'`.
- **Pane Header / Quick Close**:
  - When `isSplitMode === true`, each pane renders a subtle top status/focus bar (or top-right floating badge) indicating active focus, with a close (`×`) button on the right pane.
- **Toolbar Action Routing**:
  - `Reconnect`, `Reset Session`, `Script Library Drawer`, and `Select/Copy Mode` route to the currently focused pane (`activeTerminalRef`).
  - `Zoom In` and `Zoom Out` invoke `zoomIn()` / `zoomOut()` on both panes simultaneously to keep font sizes synchronized.
- **Keyboard Shortcuts** (active when `subTab === 'interactive'`):
  - `Alt + D`: Toggle split pane (or open split pane if closed).
  - `Alt + W`: Close split pane if open.
  - `Alt + ArrowLeft` / `Alt + ArrowRight`: Switch focus between left (`main`) and right (`split`) panes.

### 2.3 Draggable Divider & Refit Synchronization
- A vertical splitter bar (`w-1.5 cursor-col-resize`) sits between the left and right pane containers.
- Dragging updates `splitRatio` (clamped to `[20, 80]`) and triggers `requestAnimationFrame`-throttled `fit()` calls on both `mainTerminalRef` and `splitTerminalRef`.
- Double-clicking the divider resets `splitRatio` to `50` and refits both panes.

### 2.4 `WebTerminalView` & `useTerminalWebSocket` Extensions
- New props on `WebTerminalViewProps`:
  - `paneId?: 'main' | 'split'` (defaults to `'main'`).
  - `isFocusedPane?: boolean` (visual indicator & focus handling).
  - `onFocusPane?: () => void` (triggered on pointerdown / focus inside the terminal container).
  - `onPaneCloseRequest?: () => void` (triggered when the shell process in the `split` pane exits or requests closure).
- New method on `WebTerminalHandle`:
  - `closePaneSession: () => void`: Sends `JSON:{"type":"pane_close"}` over the pane's WebSocket before closing the socket.
  - `focus: () => void`: Focuses the underlying `xterm` instance.

---

## 3. Hub Server Architecture & Protocol

### 3.1 Session Indexing in `TerminalHostManager`
- Extend session storage in `TerminalHostManager`:
  - Primary sessions remain accessible via `getSession(hostId)` (which resolves `paneId = 'main'`).
  - Add `getSession(hostId, paneId: string = 'main')` and `getOrCreatePaneSession(hostId, paneId)` using composite key `${canonicalHostId}::${paneId}` for non-main panes (or unified map keyed by `paneId === 'main' ? canonicalHostId : `${canonicalHostId}::${paneId}``).
  - When an agent disconnects or is pruned, all pane sessions belonging to `canonicalHostId` are notified/cleaned up.

### 3.2 WebSocket Endpoint (`/api/terminal/ws`)
- Parse optional query parameter `paneId` from `/api/terminal/ws?hostId=...&paneId=...` (sanitized to alphanumeric/dash/underscore, defaulting to `'main'`).
- Attach the client WebSocket to the corresponding `RemoteAgentTerminalSession(hostId, paneId)`.
- Handle client control frames in `terminalWs.ts`:
  - `resize`: Calls `session.resize(cols, rows, force)`.
  - `reset`: Calls `session.reset(true, true)`.
  - `pane_close`: If `paneId !== 'main'`, calls `hostMgr.destroyPaneSession(hostId, paneId, true)` which instructs the agent to kill the secondary PTY and removes the Hub session buffer.

### 3.3 Hub ⇄ Agent Multiplexing Protocol
To maintain 100% backward compatibility with existing single-pane agents and tests:
- **For `paneId === 'main'`**:
  - Hub → Agent input: Raw string/buffer (unchanged).
  - Hub → Agent control: `JSON:{"type":"resize","cols":...,"rows":...}`, `JSON:{"type":"reset"}`, `JSON:{"type":"history_req"}` (unchanged).
  - Agent → Hub output: Raw string/buffer and `BIN_MSG_TYPE.HISTORY_SYNC` with `id = hostId` (unchanged).
- **For `paneId !== 'main'` (e.g. `'split'`)**:
  - Hub → Agent input: Encoded with `encodeBinaryPacket(BIN_MSG_TYPE.TERMINAL_RAW, paneId, Buffer.from(data, 'utf-8'))` (or `JSON:{"type":"pane_input","paneId":"split","data":...}`). Using `BIN_MSG_TYPE.TERMINAL_RAW (0x03)` with `id = paneId` is zero-overhead and already defined in `src/shared/protocol/binaryProtocol.ts`.
  - Hub → Agent control:
    - `JSON:{"type":"resize","paneId":"split","cols":...,"rows":...}`
    - `JSON:{"type":"reset","paneId":"split"}`
    - `JSON:{"type":"history_req","paneId":"split"}`
    - `JSON:{"type":"pane_close","paneId":"split"}`
  - Agent → Hub output:
    - Live output: `encodeBinaryPacket(BIN_MSG_TYPE.TERMINAL_RAW, paneId, chunkBuf)`
    - History sync: `encodeBinaryPacket(BIN_MSG_TYPE.HISTORY_SYNC, paneId, histBuf)`
    - Shell exit event: `JSON:{"type":"pane_exit","paneId":"split","exitCode":0}`

---

## 4. Agent Daemon Multi-PTY Management (`src/agent/daemon.ts`)

### 4.1 Secondary PTY Lifecycle
- Maintain a map of secondary PTY panes (`secondaryPanes: Map<string, SecondaryPaneState>`) alongside the primary `ptyProcess` (or unify into a pane state helper where `'main'` is pre-spawned on connect and `'split'` is spawned on demand).
- Each pane state holds:
  - `ptyProcess`: NodePty / PosixPty / InteractivePipe instance.
  - `ptyBatcher`: `StreamBatcher` instance.
  - `ptyDecoder`: `StringDecoder('utf8')`.
  - `terminalHistory`: `TerminalHistoryBuffer`.
  - `cols`, `rows`: Last known dimensions.

### 4.2 Lazy Spawn & Destruction Rules
1. **Lazy Spawn**: When the Agent receives `resize`, `history_req`, `reset`, or `TERMINAL_RAW` input for `paneId = 'split'` and no PTY exists yet for `'split'`, it spawns a new shell PTY with those dimensions.
2. **Natural Shell Exit (`exit` command)**:
   - For `'main'`: Keeps existing behavior (respawns after 500ms so the main console is always available).
   - For `'split'`: Does **not** respawn. Flushes output, clears history, removes the pane entry, and sends `JSON:{"type":"pane_exit","paneId":"split","exitCode":exitCode}` to the Hub.
3. **Explicit Close (`pane_close`)**:
   - When the Agent receives `JSON:{"type":"pane_close","paneId":"split"}`, it kills the `'split'` PTY process, clears its history buffer, and removes the pane entry.

---

## 5. Error Handling & Edge Cases

1. **Host Switch While Split is Active**:
   - Switching `activeHostId` in `TerminalHostSelector` reconnects both `'main'` and `'split'` panes to the newly selected host (or restores the target host's saved split state).
2. **Browser Refresh / Network Drop**:
   - Because `isSplitMode` is persisted and the Agent keeps `'split'` alive until explicitly closed, refreshing the browser re-establishes `/api/terminal/ws?hostId=...&paneId=split` and replays the scrollback history seamlessly.
3. **Rapid Drag Resizing**:
   - `WebTerminalView` already debounces resize frames; the splitter drag handler uses `requestAnimationFrame` to keep UI resizing smooth without flooding WebSocket resize frames.
4. **Legacy Agent Compatibility**:
   - If an older agent does not recognize `BIN_MSG_TYPE.TERMINAL_RAW` or `paneId: 'split'`, `daemon.ts` safely ignores unknown control messages without crashing the primary session.

---

## 6. Testing Strategy

1. **Unit & Integration Tests (`tests/`)**:
   - `TerminalHostManager`: Verify independent sessions for `(hostId, 'main')` and `(hostId, 'split')`, isolated history buffers, independent resize dimensions, and `destroyPaneSession` cleanup.
   - `terminalWs`: Verify `/api/terminal/ws?hostId=...&paneId=split` routing, binary `TERMINAL_RAW` multiplexing between Hub and Agent, `pane_close` handling, and `pane_exit` propagation to browser client.
2. **Frontend Component Tests**:
   - Verify split button toggles secondary `WebTerminalView`, updates focus state (`activePane`), routes toolbar actions to focused pane, adjusts width ratio via splitter, and collapses when `pane_exit` is received.
