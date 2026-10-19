# 终端缓冲区调整为 1MB 与 WebSocket 压缩传输设计规范 (Design Spec)

- **日期**: 2026-10-19
- **状态**: Approved
- **作者**: Claude Assistant & gt-hub Team
- **范围**: `TerminalHistoryBuffer`、`RemoteAgentTerminalSession`、`terminalWs.ts`、`daemon.ts` 及相关测试

---

## 1. 背景与目标

### 1.1 现状与痛点
在 `gt-hub` 的远程终端架构中：
1. **历史缓冲区上限过大**：Agent 守护进程的 `TerminalHistoryBuffer` 和 Hub 服务端的 `RemoteAgentTerminalSession` 默认均配置为 2MB 环形缓冲区。
2. **首次连接全量裸传**：当用户在浏览器打开 WebTerminal 连接时，服务端会将这完整的 2MB 历史文本数据未经压缩原样下发。
3. **网络与性能瓶颈**：在移动端或弱网环境下，下载 2MB 原始字符流不仅耗费流量，还会造成明显的连接等待；同时前端 xterm.js 接收 2MB 纯文本并做 VT100 解析会引起主线程短时间掉帧，随后又根据 `scrollback`（桌面 8000 行 / 移动 3000 行）将大量解析完的旧行丢弃。

### 1.2 优化目标
1. **缓冲上限收敛**：将 Agent 节点与 Hub 服务端的历史输出缓冲区默认容量统一调整为 **1MB**（`1 * 1024 * 1024` 字节），在保留充足回溯历史的同时，减少 50% 内存驻留与潜在传输量。
2. **WebSocket 压缩传输**：基于 RFC 7692 标准引入 `permessage-deflate` 协议协商，对 WebSocket 终端流（Hub ↔ Browser、Agent ↔ Hub）启用透明压缩传输。
3. **延迟与吞吐兼顾**：设置 1KB 压缩阈值，确保单字符按键、极短控制指令零延迟原样发送，大段日志与历史回放享受 70%~90% 的网络体积压缩。

---

## 2. 详细技术方案

### 2.1 缓冲区容量调整（1MB 对齐）

#### 2.1.1 Agent 端
- `src/agent/pty/terminalHistoryBuffer.ts`:
  - 将构造函数默认值由 `2 * 1024 * 1024` 调整为 `1 * 1024 * 1024`。
- `src/agent/daemon.ts`:
  - 启动参数解析回退值由 `(2 * 1024 * 1024)` 调整为 `(1 * 1024 * 1024)`。

#### 2.1.2 Hub 服务端
- `src/terminal/services/terminalHostManager.ts`:
  - `RemoteAgentTerminalSession.maxBufferSize` 常量由 `2 * 1024 * 1024` 调整为 `1 * 1024 * 1024`。

---

### 2.2 WebSocket `permessage-deflate` 压缩设计

#### 2.2.1 压缩参数配置
在 `src/shared/protocol/wsOptions.ts`（或 `src/terminal/routes/terminalWs.ts`）中定义专用的终端压缩选项：

```typescript
export const TERMINAL_WS_DEFLATE_OPTIONS = {
  zlibDeflateOptions: {
    chunkSize: 1024,
    memLevel: 7,
    level: 3, // 速度优先的快速压缩级别，CPU 占用极小且压缩率良好
  },
  zlibInflateOptions: {
    chunkSize: 10 * 1024,
  },
  // 阈值限制：低于 1024 字节的数据帧不进行压缩，避免单字符按键增加延迟与网络开销
  threshold: 1024,
  // 双方均不长期保持解压上下文，防止高并发长连接下的内存持续驻留
  clientNoContextTakeover: true,
  serverNoContextTakeover: true,
};
```

#### 2.2.2 服务端配置 (`src/terminal/routes/terminalWs.ts`)
在 `setupTerminalWebSocket` 中实例化 `WebSocketServer` 时注入配置：
- `wss = new WebSocketServer({ noServer: true, permessageDeflate: TERMINAL_WS_DEFLATE_OPTIONS })`
- `agentWss = new WebSocketServer({ noServer: true, permessageDeflate: TERMINAL_WS_DEFLATE_OPTIONS })`
- `execWss = new WebSocketServer({ noServer: true, permessageDeflate: TERMINAL_WS_DEFLATE_OPTIONS })`

#### 2.2.3 Agent 客户端配置 (`src/agent/daemon.ts`)
在向 Hub 发起逆向连接的 `new WebSocket(targetWsUrl, { ... })` 中开启支持：
```typescript
ws = new WebSocket(targetWsUrl, {
  headers: { 'x-admin-key': adminKey },
  permessageDeflate: {
    threshold: 1024,
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
  },
});
```

#### 2.2.4 浏览器端 (`WebTerminalView.tsx`)
浏览器原生 `WebSocket` 引擎在握手请求头中会自动包含 `Sec-WebSocket-Extensions: permessage-deflate`，无需修改任何前端代码即可自动开启透明解压缩。

---

## 3. 边界情况与防错处理

1. **小包延迟保护**：用户在终端中敲击键盘（例如 `ls\r`、单字母输入）均为极短帧（< 10 字节），`threshold: 1024` 会直接跳过 Deflate 流程，确保输入无任何感知延迟。
2. **大日志传输收益**：对于历史流回放（最多 1MB）或大文件 `cat` 输出，文本数据具有极高重复度，经 gzip/deflate 压缩后通常缩减至 80KB ~ 150KB，传输带宽与延迟降低 85% 以上。
3. **内存控制**：通过设置 `clientNoContextTakeover` 和 `serverNoContextTakeover`，每个帧独立压缩/解压缩，无需在服务端为每个空闲终端 WebSocket 维持长期未释放的 zlib 字典树，避免多会话内存泄漏。
4. **向后兼容性**：若有第三方旧客户端或不发送 `Sec-WebSocket-Extensions` 的客户端接入，WebSocketServer 协议层会自动降级为普通未压缩传输，互不影响。

---

## 4. 验证计划

1. **单元测试与集成测试**：
   - 编写 `tests/terminalDeflateAndBufferLimit.test.ts`：
     - 测试 `TerminalHistoryBuffer` 和 `RemoteAgentTerminalSession` 默认大小为 1MB。
     - 测试 WebSocketServer 能够成功协商 `permessage-deflate` 握手。
     - 测试大包（> 1024 字节）与小包（< 1024 字节）在启用压缩通道下的数据完整性。
   - 运行受影响的历史测试（如 `terminalPersistence.test.ts`），断言更新至 1MB 逻辑。
2. **全量构建与全量测试**：
   - 执行 `npm run build`
   - 执行 `npm test`，确保全部套件无报错通过。
