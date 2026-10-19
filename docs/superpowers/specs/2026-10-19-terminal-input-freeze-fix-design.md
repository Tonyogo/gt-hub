# Web 终端输入无响应与假死问题全链路修复设计方案

- **日期**: 2026-10-19
- **状态**: 已批准 (Approved)
- **关联模块**:
  - `frontend/src/utils/terminalImeHelper.ts`
  - `frontend/src/utils/apiClient.ts`
  - `frontend/src/components/WebTerminalView.tsx`
  - `frontend/src/components/terminal/hooks/useTerminalWebSocket.ts`
  - `src/terminal/services/terminalHostManager.ts`
  - `src/agent/pty/drivers.ts`
  - `src/agent/daemon.ts`

---

## 1. 背景与根因分析

在使用 Web 终端时，用户偶发遇到“敲击命令无反应、像卡住一样”的现象。经全链路代码审查，定位出以下 6 个具体根因：

1. **IME 拦截器吞字与冗余 Hooks 挂载**：
   - `terminalImeHelper.ts` 在 `handleInput` 中通过 `inputEv.data === lastHandledData && (now - lastHandledTime) < 60` 对 `beforeinput` 和 `input` 去重。当用户在 60ms 内快速连击两个相同字符（如 `ll`、`--`、`00`）且走到了 `input` 分支时，第二个字符被误判为重复事件直接吞掉。
   - `compositionend` 强制保持 `isComposing = true` 达 60ms，若用户选词后立即敲击回车或下一个字符（<60ms），输入会被拦截丢弃。
   - `WebTerminalView.tsx` 底部冗余调用了未实际接线的 `useTerminalSelection` 和 `useTerminalIme`，造成多余的状态与事件开销。
   - 桌面端划选复制的 fallback 分支创建临时 `textarea` 并 `focus()` 后未归还焦点给 `xterm`，导致终端失焦后敲击无反应。

2. **`requestAuthTicket` 缺乏超时控制与 `initWebSocket` 并发竞态**：
   - `apiClient.ts` 中的 `requestAuthTicket()` 发起 `fetch('/api/auth/ticket')` 时没有任何超时控制，网络异常或代理挂起时会导致连接协程永久卡在 `isConnecting` 状态。
   - `initWebSocket()` 中的异步 IIFE 在 `await requestAuthTicket()` 期间若再次触发 `initWebSocket()`（如切换节点、快速重连），旧协程返回后仍会创建孤儿 WebSocket 并覆盖 `wsRef.current`。

3. **前端 WebSocket 缺乏双向心跳超时检测（TCP 半开假连接）**：
   - 前端每 15s 发送 `JSON:{"type":"ping"}`，但从未校验 `pong` 是否超时。当电脑休眠唤醒、移动端切后台或 NAT 掐断连接产生 TCP 半开（Half-open socket）时，`ws.readyState` 仍为 `OPEN`，UI 显示绿色“已连接”，但用户敲击的所有指令都写入了失效的本地缓冲区。

4. **Agent 断线时 Hub 未通知前端，静默丢弃所有输入**：
   - 当 Agent 节点断线触发 `unregisterAgent()` 时，`RemoteAgentTerminalSession` 仅将 `agentWs` 置为 `null`，并未通知或断开 `activeSockets` 中的浏览器客户端。浏览器端依然显示“已连接”，用户敲击的数据到达 `session.write()` 后被静默丢弃。

5. **1MB 历史缓冲区单帧重放导致队头阻塞 (Head-of-Line Blocking)**：
   - 历史缓冲区上限提升至 1MB 并启用 `perMessageDeflate` 后，`attach()` 与 `handleHistorySync()` 将最高 1MB 的历史字符串作为单个 WebSocket 帧一次性发送，压缩/解压大帧期间会阻塞实时按键回显。

6. **POSIX PTY 默认开启 `IXON` 软件流控导致误按 `Ctrl+S` 锁死终端**：
   - 终端默认启用 `IXON` (XON/XOFF)，用户习惯性按下 `Ctrl+S` (`\x13`) 时会挂起内核 PTY 输出流，导致终端画面彻底冻结，敲击任何命令均无回显。

---

## 2. 架构与详细设计

采用 **方案 A（全链路精准修复 + 状态闭环与流控优化）**，在不破坏现有协议与测试兼容性的前提下，分三层完成闭环修复。

### 2.1 第一层：前端输入、IME 去重与焦点保护

1. **移除 `WebTerminalView.tsx` 中的冗余 Hook 调用**：
   - 删除 `WebTerminalView.tsx` 底部对 `useTerminalSelection({...})` 和 `useTerminalIme({...})` 的冗余调用，保留文件末尾的模块重导出 `export { useTerminalWebSocket, useTerminalSelection, useTerminalIme }`。

2. **精准化 `terminalImeHelper.ts` 事件对去重与 Composition 解锁**：
   - 引入布尔标志 `handledByBeforeInput`：当 `handleBeforeInput` 拦截并发送了 `e.data` 时，设置 `handledByBeforeInput = true` 并记录 `lastHandledData = e.data`、`lastHandledTime = Date.now()`。
   - 在 `handleInput` 中，只有当 `handledByBeforeInput && inputEv.data === lastHandledData && (now - lastHandledTime) < 60` 时才视为同一次按键事件的 `beforeinput` + `input` 对并忽略，且消费一次后立即将 `handledByBeforeInput = false` 复位！这样即便用户在 10ms 内连续两次触发 `input` 输入相同字符 `'l'`，第二次因为 `handledByBeforeInput` 已为 `false` 也会正常送达终端。
   - 在 `handleKeyDown` 中：每次收到新的 `keydown` 事件时，立即重置 `handledByBeforeInput = false`；若收到非 229 的物理按键且 `compositionEndTimer` 正在倒计时，立即清除 `compositionEndTimer` 并将 `isComposing = false`，避免选词后紧跟的物理按键或回车被吞。

3. **桌面划选复制 Fallback 焦点恢复**：
   - 在 `WebTerminalView.tsx` 的 `handleMouseUp` 与 `handleCopySelection` 中，当使用临时 `textarea` 执行 `document.execCommand('copy')` 并移除 DOM 后，调用 `xtermRef.current?.focus()` 恢复终端输入焦点。

### 2.2 第二层：前端 WebSocket 连接竞态、Ticket 超时与双向心跳

1. **`requestAuthTicket` 超时控制 (`frontend/src/utils/apiClient.ts`)**：
   - 为 `requestAuthTicket(adminKey?: string, timeoutMs: number = 5000)` 增加 `AbortController` 超时机制：
     ```ts
     const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
     const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
     ```
   - 请求结束或异常时 `clearTimeout(timer)`，超时或失败均返回 `null`，确保 `initWebSocket` 最多等待 5s 即可继续回退或重连。

2. **连接代次令牌 `connectSeqRef` (`WebTerminalView.tsx` & `useTerminalWebSocket.ts`)**：
   - 新增 `const connectSeqRef = useRef<number>(0)`。
   - 每次调用 `initWebSocket()` 以及组件卸载 cleanup 时，执行 `const currentSeq = ++connectSeqRef.current`。
   - 在 `await requestAuthTicket(adminKey)` 之后，检查 `if (!isMountedRef.current || currentSeq !== connectSeqRef.current) return;`，彻底阻止过期异步协程创建孤儿 WebSocket。

3. **双向心跳 Pong 超时检测与页面唤醒探测 (`WebTerminalView.tsx` & `useTerminalWebSocket.ts`)**：
   - 新增 `const lastPongTimeRef = useRef<number>(Date.now())`。
   - 在 `ws.onopen` 和 `ws.onmessage` 入口处更新 `lastPongTimeRef.current = Date.now()`。
   - 在 15s 的 `pingIntervalRef` 定时器中：
     - 若 `Date.now() - lastPongTimeRef.current > 35000`（超过两轮心跳未收到任何响应或数据），判定为半开假死连接，主动调用 `ws.close(4000, 'Heartbeat pong timeout')` 并触发重连。
   - 监听 `window.addEventListener('online', ...)` 与 `document.addEventListener('visibilitychange', ...)`：
     - 当网络恢复或页面恢复可见时，若当前存在活跃 `activeHostId` 且连接已断开（`!wsRef.current || wsRef.current.readyState > WebSocket.OPEN`），立即重置重连计数并调用 `initWebSocket()`；若连接处于 `OPEN` 状态且距离上次收包超过 10s，立即发送一次 `JSON:{"type":"ping"}` 探测。

### 2.3 第三层：Hub 离线状态联动、历史分片流控与 Agent PTY 防锁死

1. **Hub 端 Agent 断线通知与短期输入缓冲 (`src/terminal/services/terminalHostManager.ts`)**：
   - 在 `RemoteAgentTerminalSession` 中新增：
     - `private pendingInputBuffer: string[] = []` 与 `private pendingInputBytes: number = 0`（上限 `maxPendingInputBytes = 4096`）。
     - 当 `write(data)` 被调用但 `agentWs` 暂未就绪（`!this.agentWs || this.agentWs.readyState !== 1`）时，��� `data` 存入 `pendingInputBuffer`（超出 4KB 时淘汰最早的片段）。
     - 当 `updateAgentWs(agentWs)` 传入新的可用连接（`agentWs && agentWs.readyState === 1`）时，立即将 `pendingInputBuffer` 中的数据依次发送给 `agentWs` 并清空缓冲。
     - 新增 `notifyAgentDisconnected()` 方法：当 `unregisterAgent` 确认当前活跃 `agentWs` 断开时，向 `activeSockets` 中所有客户端发送 `JSON:{"type":"agent_offline","hostId":this.hostId}` 并调用 `ws.close(1012, 'Agent disconnected')`，使前端立即感知离线并进入自动重连流程。

2. **1MB 历史缓冲区重放分块发送 (`src/terminal/services/terminalHostManager.ts`)**：
   - 在 `RemoteAgentTerminalSession` 中新增私有方法 `sendHistoryChunks(ws: any, sanitized: string)`，单块阈值 `HISTORY_CHUNK_SIZE = 64 * 1024`（64KB）：
     - 当 `sanitized.length <= HISTORY_CHUNK_SIZE` 时，直接调用 `ws.send(sanitized)`。
     - 当 `sanitized.length > HISTORY_CHUNK_SIZE` 时，按 64KB 切片循环调用 `ws.send(chunk)`，避免产生单帧 1MB 的巨型 zlib 压缩块阻塞 WebSocket 解析器。

3. **禁用 PTY `IXON` 软件流控锁死 (`src/agent/pty/drivers.ts` & `src/agent/daemon.ts`)**：
   - 在 `PosixPtyDriver` 的内嵌 Python 脚本中（`drivers.ts`），在 `pty.openpty()` 之后读取并修改 `slave` 的 termios 属性：
     ```python
     attrs = termios.tcgetattr(slave)
     attrs[0] &= ~termios.IXON
     termios.tcsetattr(slave, termios.TCSANOW, attrs)
     ```
   - 在 `daemon.ts` 和 `drivers.ts` 的 `NodePtyDriver` 中，对非 Windows 平台确保不会因 `IXON` 锁死终端回显（在 `daemon.ts` 中若检测到用户处于交互式 PTY，或通过 `stty -ixon` / termios 保障 `Ctrl+S` 不会挂起 PTY 输出流）。

---

## 3. 错误处理与边界条件

- **向后兼容性**：
  - `sendHistoryChunks` 在历史记录 $\le 64\text{KB}$ 时保持单次 `ws.send(sanitized)` 调用，确保所有断言 `expect(ws.send).toHaveBeenCalledWith(...)` 的现有单元测试 100% 兼容。
  - `requestAuthTicket` 在测试环境（可能未定义 `AbortController` 或使用 mock `fetch`）中做安全特性检测：仅当 `AbortController` 存在时传递 `signal`，并在 `fetch` 只接受单参或忽略 `signal` 时保持完全兼容。
- **重置与销毁清理**：
  - `RemoteAgentTerminalSession.reset()` 和 `destroy()` 时同步清空 `pendingInputBuffer` 与 `pendingInputBytes`。
  - 前端组件卸载时递增 `connectSeqRef.current` 并移除 `visibilitychange` / `online` 事件监听，确保无内存泄漏或未清理的定时器句柄。

---

## 4. 测试验证计划

1. **单元测试 (`tests/terminalInputFreezeFixes.test.ts`)**：
   - 验证 `terminalImeHelper` 在 60ms 内连续快速输入相同字符（如 `'l'`, `'l'`）不会被误吞。
   - 验证 `terminalImeHelper` 在 `compositionend` 后立即按下物理按键（如 Enter / 字母）不会被 60ms 延迟锁丢弃。
   - 验证 `requestAuthTicket` 在请求挂起超过超时时间后能自动中止并返回 `null`。
   - 验证 `RemoteAgentTerminalSession` 在 Agent 断线时主动通知并关闭客户端连接，且重连窗口内的输入能在 Agent 恢复时自动冲刷（flush）。
   - 验证 `RemoteAgentTerminalSession` 对超过 64KB 的历史记录按 64KB 分片发送，对小于 64KB 的历史记录单次发送。
   - 验证 `PosixPtyDriver` 包含 `~termios.IXON` 配置。
   - 验证 `WebTerminalView.tsx` 已移除冗余 Hook 调用，并包含 `connectSeqRef` 与 `lastPongTimeRef` 双向心跳超时检测。
2. **回归测试**：
   - 运行现有的 `tests/terminalImeHelper.test.ts`、`tests/terminalHostManager.test.ts`、`tests/terminalWs.test.ts`、`tests/terminalSluggishnessAndFileLoadFixes.test.ts`，确保全部通过。
