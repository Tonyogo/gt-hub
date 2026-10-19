# 终端缓冲区调整为 1MB 与 WebSocket 压缩传输实施计划 (Implementation Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `gt-hub` 的终端历史流缓冲区大小（Agent 节点与 Hub 服务端）统一调整为 1MB，并在 WebSocket 终端全链路（Hub ↔ Browser、Agent ↔ Hub、Exec WS）启用 `permessage-deflate` 压缩传输，大幅减少网络传输体积与首屏加载延迟。

**Architecture:** 
1. 缓冲区层：统一将 `TerminalHistoryBuffer` 与 `RemoteAgentTerminalSession` 历史环形缓冲容量收敛至 1MB（`1048576` 字节）。
2. 传输协议层：基于 RFC 7692 规范，在 Hub 端的三个 WebSocket 服务（`wss`、`agentWss`、`execWss`）与 Agent 端的客户端连接中配置 `permessageDeflate` 参数，配置 1KB 压缩阈值与快速压缩级别，确保单字符低延迟与大日志高压缩。

**Tech Stack:** Node.js, TypeScript, ws (`WebSocket` & `WebSocketServer`), zlib (deflate/inflate), Jest.

## Global Constraints

- **缓冲区容量对齐**：Agent 端与 Hub 端的历史缓冲区默认上限必须完全一致，设定为 `1 * 1024 * 1024`（1MB）。
- **按键低延迟保护**：`permessageDeflate` 必须设置 `threshold: 1024`（低于 1KB 的单字符按键与控制指令不得进行压缩，零 CPU/延迟损耗）。
- **无上下文保持**：必须配置 `clientNoContextTakeover: true` 与 `serverNoContextTakeover: true`，防止多客户端长期连接产生 zlib 字典树内存驻留。
- **向后兼容性**：不支持压缩的旧客户端连接必须能够自动平滑降级为普通未压缩通道，不可断开连接。
- **测试标准**：测试执行必须遵循 `npm test -- <test-file>` 并附带 `--detectOpenHandles --forceExit`。

---

### Task 1: 编写缓冲区大小与 WebSocket Deflate 自动化测试套件

**Files:**
- Create: `tests/terminalDeflateAndBufferLimit.test.ts`

**Interfaces:**
- Consumes: `TerminalHistoryBuffer` (`src/agent/pty/terminalHistoryBuffer.ts`), `RemoteAgentTerminalSession` (`src/terminal/services/terminalHostManager.ts`), `setupTerminalWebSocket` (`src/terminal/routes/terminalWs.ts`)
- Produces: 自动化测试套件，验证 1MB 边界截断以及 WebSocket 服务握手包含 `permessage-deflate` 扩展并可正确传输解压缩数据。

- [x] **Step 1: 编写测试文件**

```typescript
// tests/terminalDeflateAndBufferLimit.test.ts
import http from 'http';
import WebSocket from 'ws';
import express from 'express';
import { TerminalHistoryBuffer } from '../src/agent/pty/terminalHistoryBuffer';
import { RemoteAgentTerminalSession } from '../src/terminal/services/terminalHostManager';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';

describe('Terminal Buffer 1MB Limit & WebSocket Deflate Compression', () => {
  describe('Buffer 1MB Sizing', () => {
    it('TerminalHistoryBuffer defaults to 1MB maxBytes', () => {
      const buf = new TerminalHistoryBuffer();
      // Push 1.2MB data
      const chunk = Buffer.alloc(1.2 * 1024 * 1024, 'x');
      buf.push(chunk);
      expect(buf.getSize()).toBe(1 * 1024 * 1024);
    });

    it('RemoteAgentTerminalSession defaults to 1MB maxBufferSize', () => {
      const session = new RemoteAgentTerminalSession('test-host-1mb');
      const chunk1 = 'A'.repeat(0.8 * 1024 * 1024);
      const chunk2 = 'B'.repeat(0.5 * 1024 * 1024);
      session.handleData(chunk1);
      session.handleData(chunk2);
      expect(session.getHistory().length).toBe(1 * 1024 * 1024);
      expect(session.getHistory().startsWith('A')).toBe(true);
      expect(session.getHistory().endsWith('B')).toBe(true);
    });
  });

  describe('WebSocket Permessage-Deflate Negotiation', () => {
    let server: http.Server;
    let port: number;
    let wss: any;

    beforeAll((done) => {
      const app = express();
      server = http.createServer(app);
      wss = setupTerminalWebSocket(server);
      server.listen(0, () => {
        const addr = server.address() as any;
        port = addr.port;
        done();
      });
    });

    afterAll((done) => {
      if (wss) {
        try { wss.close(); } catch {}
      }
      if (typeof (server as any).closeAllConnections === 'function') {
        (server as any).closeAllConnections();
      }
      server.close(done);
    });

    it('negotiates permessage-deflate extension with connecting clients', (done) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/agent-ws?hostId=agent-deflate-test`, {
        permessageDeflate: true,
      });

      ws.on('upgrade', (res) => {
        const extensions = res.headers['sec-websocket-extensions'] || '';
        expect(extensions).toContain('permessage-deflate');
      });

      ws.on('open', () => {
        // Send a message larger than 1024 bytes to trigger compression
        const largePayload = 'JSON:' + JSON.stringify({
          type: 'cmd_stream_data',
          data: 'Z'.repeat(4096),
        });
        ws.send(largePayload);

        setTimeout(() => {
          ws.close();
          done();
        }, 100);
      });

      ws.on('error', (err) => {
        done(err);
      });
    });
  });
});
```

- [x] **Step 2: 运行测试以验证它失败**

运行: `npm test -- tests/terminalDeflateAndBufferLimit.test.ts`
预期: 失败（FAIL，因为当前默认容量为 2MB，且 WebSocket 未开启 permessage-deflate 导致握手扩展头不匹配）

- [x] **Step 3: 提交初始测试文件**

```bash
git add tests/terminalDeflateAndBufferLimit.test.ts
git commit -m "test: add test suite for 1MB terminal buffer limit and permessage-deflate"
```

---

### Task 2: 将 Agent 与 Hub 缓冲区调整为 1MB 并更新现有历史测试

**Files:**
- Modify: `src/agent/pty/terminalHistoryBuffer.ts:20-26`
- Modify: `src/agent/daemon.ts:596-600`
- Modify: `src/terminal/services/terminalHostManager.ts:54-56`
- Modify: `tests/terminalPersistence.test.ts:63-88`
- Modify: `tests/terminalSluggishnessAndFileLoadFixes.test.ts:110-129`

**Interfaces:**
- Consumes: `TerminalHistoryBuffer`, `RemoteAgentTerminalSession`
- Produces: 统一的 1MB 默认容量行为。

- [x] **Step 1: 修改 `src/agent/pty/terminalHistoryBuffer.ts` 默认容量**
在构造函数中将默认 `maxBytes` 设为 `1 * 1024 * 1024`：
```typescript
constructor(maxBytes: number = 1 * 1024 * 1024) {
  this.maxBytes = Math.max(1, maxBytes);
}
```

- [x] **Step 2: 修改 `src/agent/daemon.ts` 中的回退容量**
将 `maxScrollbackBytes` 的缺省值由 2MB 修改为 1MB：
```typescript
const maxScrollbackBytes = options.scrollback
  ? Math.max(1024, parseInt(String(options.scrollback), 10) || (1 * 1024 * 1024))
  : (1 * 1024 * 1024);
```

- [x] **Step 3: 修改 `src/terminal/services/terminalHostManager.ts` 中的容量常量**
将 `RemoteAgentTerminalSession.maxBufferSize` 由 2MB 改为 1MB：
```typescript
private readonly maxBufferSize: number = 1 * 1024 * 1024; // 1MB scrollback
```

- [x] **Step 4: 更新受容量影响的历史单元测试断言**
1. 在 `tests/terminalPersistence.test.ts` 中：
将测试用例 `should support up to 2MB buffer...` 重构为测试 1MB 容量上限（chunk1: 0.6MB, chunk2: 0.4MB, chunk3: 0.3MB，总计 1.3MB > 1MB，断言 `expect(history.length).toBeLessThanOrEqual(1 * 1024 * 1024)`）。
2. 在 `tests/terminalSluggishnessAndFileLoadFixes.test.ts` 中：
将 `slices excess without wiping entire 2MB buffer chunk` 的 `const max = 2 * 1024 * 1024;` 调整为 `const max = 1 * 1024 * 1024;`，chunk1 调整为 0.6MB，chunk2 调整为 0.7MB（产生 0.3MB 溢出并验证精准裁剪）。

- [x] **Step 5: 运行测试验证**

运行: `npm test -- tests/terminalPersistence.test.ts tests/terminalSluggishnessAndFileLoadFixes.test.ts tests/terminalHistoryBuffer.test.ts`
预期: 全部通过 (PASS)

- [x] **Step 6: 提交变更**

```bash
git add src/agent/pty/terminalHistoryBuffer.ts src/agent/daemon.ts src/terminal/services/terminalHostManager.ts tests/terminalPersistence.test.ts tests/terminalSluggishnessAndFileLoadFixes.test.ts
git commit -m "feat(terminal): adjust agent and hub terminal buffer default to 1MB"
```

---

### Task 3: 在 Hub 服务端与 Agent 客户端启用 WebSocket `permessage-deflate` 压缩

**Files:**
- Create: `src/shared/protocol/wsOptions.ts`
- Modify: `src/terminal/routes/terminalWs.ts:13-20`
- Modify: `src/agent/daemon.ts:922-927`
- Test: `tests/terminalDeflateAndBufferLimit.test.ts`

**Interfaces:**
- Consumes: `TERMINAL_WS_DEFLATE_OPTIONS`
- Produces: 启用了 `permessageDeflate` 的 WebSocketServer 与 Agent WebSocket 客户端。

- [x] **Step 1: 创建共享的 WebSocket 压缩配置**
创建 `src/shared/protocol/wsOptions.ts`：
```typescript
/**
 * Shared permessage-deflate compression configuration for terminal WebSocket streams.
 * Balances compression ratio, memory footprint, and low latency for small keystrokes.
 */
export const TERMINAL_WS_DEFLATE_OPTIONS = {
  zlibDeflateOptions: {
    chunkSize: 1024,
    memLevel: 7,
    level: 3, // Fast compression level
  },
  zlibInflateOptions: {
    chunkSize: 10 * 1024,
  },
  threshold: 1024, // Frames under 1024 bytes bypass compression to avoid latency
  clientNoContextTakeover: true,
  serverNoContextTakeover: true,
};
```

- [x] **Step 2: 在 `src/terminal/routes/terminalWs.ts` 中应用压缩配置**
导入 `TERMINAL_WS_DEFLATE_OPTIONS`，并将三个 `WebSocketServer` 实例化配置为：
```typescript
const wss = new WebSocketServer({ noServer: true, permessageDeflate: TERMINAL_WS_DEFLATE_OPTIONS });
const agentWss = new WebSocketServer({ noServer: true, permessageDeflate: TERMINAL_WS_DEFLATE_OPTIONS });
const execWss = new WebSocketServer({ noServer: true, permessageDeflate: TERMINAL_WS_DEFLATE_OPTIONS });
```

- [x] **Step 3: 在 `src/agent/daemon.ts` 客户端连接中启用压缩**
在 `ws = new WebSocket(targetWsUrl, { ... })` 中加入客户端压缩配置：
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

- [x] **Step 4: 运行测试验证**

运行: `npm test -- tests/terminalDeflateAndBufferLimit.test.ts tests/terminalWs.test.ts`
预期: 全部通过 (PASS)

- [x] **Step 5: 提交变更**

```bash
git add src/shared/protocol/wsOptions.ts src/terminal/routes/terminalWs.ts src/agent/daemon.ts
git commit -m "feat(terminal): enable permessage-deflate compression for terminal WebSocket streams"
```

---

### Task 4: 全局构建与全量测试套件回归验证

**Files:**
- Test: 全量编译构建产物与所有测试套件

**Interfaces:**
- Consumes: 全量源码
- Produces: 稳定发布的构建产物。

- [x] **Step 1: 构建全量工程**

运行: `npm run build`
预期: 前端构建、后端编译与 CLI `dist/gt.js` 打包均无错误。

- [x] **Step 2: 执行全量测试**

运行: `npm test`
预期: 所有单元测试与集成测试全部通过 (PASS)。

- [x] **Step 3: 检查工作区状态**

运行: `git status`
预期: 工作区干净。
