import http from 'http';
import fs from 'fs';
import os from 'os';
import net from 'net';
import zlib from 'zlib';
import crypto from 'crypto';
import path from 'path';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { WebSocket, WebSocketServer } from 'ws';
import express from 'express';
import {
  PROTOCOL_VERSION,
  BIN_MSG_TYPE,
  encodeBinaryPacket,
  decodeBinaryPacket,
  encodeControlJsonPacket,
  decodeControlJsonPacket,
  isBinaryMessageFrame,
  isValidControlPayload,
  negotiateProtocolCapabilities,
  sendControlFrame,
} from '../src/shared/protocol/binaryProtocol';
import { setupTerminalWebSocket, redactWsUrlSecrets } from '../src/terminal/routes/terminalWs';
import { TerminalHostManager, terminalHostManager, RemoteAgentTerminalSession } from '../src/terminal/services/terminalHostManager';
import { terminalExecBridge } from '../src/terminal/services/terminalExecBridge';
import { terminalProxyBridge } from '../src/terminal/services/terminalProxyBridge';
import { rpcDispatcher } from '../src/terminal/services/rpcDispatcher';
import { StreamSessionManager } from '../src/agent/pty/sessionManager';
import { makeRequest, resolveHost, resolveWebSocketUrl } from '../src/client/utils/terminalUI';
import { CliTcpTunnelClient, resolveProxyWebSocketUrl, runSpeedtestBenchmark } from '../src/client/commands/proxy';
import { downloadRemoteFile, uploadLocalFile } from '../src/client/commands/cp';
import { runStreamExec, StreamExecError } from '../src/client/commands/exec';
import { runInteractiveExec } from '../src/client/interactive/interactiveExec';
import {
  isBinaryControlPacket,
  decodeBinaryControlFrame,
  parseTerminalTextControlFrame,
  encodeBinaryControlFrame,
} from '../frontend/src/utils/terminalProtocol';
import config from '../config/default';

const GT_BIN = path.resolve(__dirname, '../scripts/gt.js');

function waitFor(condition: () => boolean, timeoutMs = 4000, intervalMs = 15, label = 'condition'): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (condition()) return resolve();
      if (Date.now() - start >= timeoutMs) {
        return reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`));
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('gt Protocol Standardization (v2)', () => {
  const originalAdminKey = config.adminSecretKey;

  afterEach(() => {
    config.adminSecretKey = originalAdminKey;
  });

  describe('Shared framing, validation, and secret redaction', () => {
    it('does not treat WebSocket text frames (isBinary=false) starting with 0x01..0x0a as binary packets', () => {
      for (const byte of [0x01, 0x03, 0x04, 0x07, 0x08, 0x09, 0x0a]) {
        const buf = Buffer.from([byte, 0x02, 0x61, 0x62]);
        expect(isBinaryMessageFrame(buf, false)).toBe(false);
        expect(isBinaryMessageFrame(buf, true)).toBe(true);
      }
      expect(isBinaryMessageFrame('JSON:{"type":"ping"}', false)).toBe(false);
      expect(isBinaryMessageFrame('JSON:{"type":"ping"}', undefined)).toBe(false);
      expect(isBinaryMessageFrame(Buffer.from([0x08, 0x00]), undefined)).toBe(true);
    });

    it('negotiates protocol v2 capabilities with v1 fallback', () => {
      const v1 = negotiateProtocolCapabilities(new URLSearchParams('hostId=h1'));
      expect(v1).toEqual({
        protocolVersion: 1,
        binaryControl: false,
        binaryFile: false,
        framedTerminal: false,
        stdinEof: false,
        binaryExec: false,
      });

      const v2 = negotiateProtocolCapabilities(
        new URLSearchParams('hostId=h2&protocolVersion=2&binaryControl=1&binaryFile=1&framedTerminal=1')
      );
      expect(v2).toEqual({
        protocolVersion: PROTOCOL_VERSION,
        binaryControl: true,
        binaryFile: true,
        framedTerminal: true,
        stdinEof: true,
        binaryExec: true,
      });

      const capped = negotiateProtocolCapabilities(new URLSearchParams('protocolVersion=99'));
      expect(capped.protocolVersion).toBe(PROTOCOL_VERSION);
    });

    it('rejects non-control JSON objects while preserving all registered control types', () => {
      expect(isValidControlPayload({ type: 'ping' })).toBe(true);
      expect(isValidControlPayload({ type: 'exec_stdin_eof' })).toBe(true);
      expect(isValidControlPayload({ type: 'cmd_stream_eof' })).toBe(true);
      expect(isValidControlPayload({ type: 'proxy_http_res_headers' })).toBe(true);
      expect(isValidControlPayload({ type: 'user_payload' })).toBe(false);
      expect(isValidControlPayload(['ping'])).toBe(false);
      expect(isValidControlPayload(null)).toBe(false);
    });

    it('clamps oversized binary CONTROL_JSON packet ids cleanly without throwing', () => {
      const longId = 'h'.repeat(320);
      const sent: any[] = [];
      const mockWs = {
        readyState: 1,
        _binaryControl: true,
        _sender: {},
        send: jest.fn((payload: any) => sent.push(payload)),
      };
      expect(sendControlFrame(mockWs, { type: 'pong' }, longId)).toBe(true);
      const decoded = decodeControlJsonPacket(sent[0]);
      expect(decoded).toEqual({ type: 'pong' });
      const pkt = decodeBinaryPacket(sent[0]);
      expect(pkt?.id.length).toBe(255);
    });

    it('redacts sensitive query parameters from WebSocket log URLs', () => {
      const redacted = redactWsUrlSecrets('/api/terminal/ws?hostId=node1&key=secret123&ticket=abc&x-admin-key=xyz');
      expect(redacted).toContain('hostId=node1');
      expect(redacted).not.toContain('secret123');
      expect(redacted).not.toContain('abc');
      expect(redacted).not.toContain('xyz');
      expect(redacted).toContain('key=***');
      expect(redacted).toContain('ticket=***');
    });
  });

  describe('Hub WebSocket protocol v2 integration', () => {
    let server: http.Server;
    let hostMgr: TerminalHostManager;
    let wss: WebSocketServer;
    let baseUrl: string;

    beforeEach((done) => {
      config.adminSecretKey = '';
      hostMgr = new TerminalHostManager();
      const app = express();
      server = http.createServer(app);
      wss = setupTerminalWebSocket(server, hostMgr, {
        agentHeartbeatIntervalMs: 80,
        agentHeartbeatTimeoutMs: 180,
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `ws://127.0.0.1:${addr.port}`;
        done();
      });
    });

    afterEach((done) => {
      try {
        (wss as any).closeAllClients?.(1001, 'Test teardown');
        wss.close();
      } catch {}
      server.close(() => done());
    });

    it('negotiates framedTerminal + binaryControl and prevents Ctrl-char and 0x02..0x0a output collision', async () => {
      const agentReceivedRaw: Buffer[] = [];
      let registeredCtrl: any = null;

      const agentWs = new WebSocket(
        `${baseUrl}/api/terminal/agent-ws?hostId=framed-node&name=framed-node&protocolVersion=2&binaryControl=1&binaryFile=1&framedTerminal=1`
      );
      agentWs.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          const decoded = decodeBinaryPacket(data);
          if (decoded?.msgType === BIN_MSG_TYPE.CONTROL_JSON) {
            const ctrl = decodeControlJsonPacket(data);
            if (ctrl?.type === 'registered') {
              registeredCtrl = ctrl;
            }
          } else if (decoded?.msgType === BIN_MSG_TYPE.TERMINAL_RAW && decoded.id === 'main') {
            agentReceivedRaw.push(decoded.payload);
          }
        }
      });
      await new Promise<void>((resolve) => agentWs.once('open', () => resolve()));

      await waitFor(() => registeredCtrl !== null);
      expect(registeredCtrl.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(registeredCtrl.capabilities).toEqual({
        binaryControl: true,
        binaryFile: true,
        framedTerminal: true,
      });

      // Connect browser terminal WS (register message handler before open)
      let browserTextOutput = '';
      const browserWs = new WebSocket(`${baseUrl}/api/terminal/ws?hostId=framed-node`);
      browserWs.on('message', (data: any) => {
        const str = typeof data === 'string' ? data : data.toString('utf-8');
        if (!str.startsWith('JSON:')) {
          browserTextOutput += str;
        }
      });
      await new Promise<void>((resolve) => browserWs.once('open', () => resolve()));

      // 1) Browser sends Ctrl+C (\x03), Ctrl+H (\x08 == CONTROL_JSON tag!), and Ctrl+A (\x01) as text frames
      browserWs.send('\x03');
      browserWs.send('\x08');
      browserWs.send('\x01');

      await waitFor(() => Buffer.concat(agentReceivedRaw).length >= 3);
      expect(Buffer.concat(agentReceivedRaw)).toEqual(Buffer.from([0x03, 0x08, 0x01]));

      // 2) Agent sends main PTY bytes starting with 0x07 (PROXY_TCP_DATA) and 0x0a (FILE_CHUNK_RES)
      // wrapped safely in TERMINAL_RAW('main')
      const dangerousBytes = Buffer.from([0x07, 0x0a, 0x03, 0x04, 0x4f, 0x4b]);
      agentWs.send(encodeBinaryPacket(BIN_MSG_TYPE.TERMINAL_RAW, 'main', dangerousBytes), {
        binary: true,
        compress: false,
      });

      await waitFor(() => browserTextOutput.includes('\x07\n\x03\x04OK'));
      expect(browserTextOutput).toContain('\x07\n\x03\x04OK');

      browserWs.close();
      agentWs.close();
    });

    it('preserves terminal dimensions and streamStarted across same-socket meta updates', () => {
      const mockAgentWs = new EventEmitter() as any;
      mockAgentWs.readyState = 1;
      mockAgentWs.send = jest.fn();

      hostMgr.registerAgent({ hostId: 'meta-host', name: 'meta-host', agentWs: mockAgentWs });
      const session = hostMgr.getSession('meta-host')!;
      session.resize(132, 43);

      const mockBrowser = new EventEmitter() as any;
      mockBrowser.readyState = 1;
      mockBrowser.send = jest.fn();
      session.attach(mockBrowser);

      // Re-registering metadata on the SAME socket must NOT reset dimensions or send duplicate history_req
      const sendCountBefore = mockAgentWs.send.mock.calls.length;
      hostMgr.registerAgent({
        hostId: 'meta-host',
        name: 'meta-host-updated',
        version: '2.0.0',
        agentWs: mockAgentWs,
      });

      expect((session as any).currentCols).toBe(132);
      expect((session as any).currentRows).toBe(43);
      expect(mockAgentWs.send.mock.calls.length).toBe(sendCountBefore);
      // Subsequent resize with same size remains a deduped no-op (not cleared to 0)
      session.resize(132, 43);
      expect(mockAgentWs.send.mock.calls.length).toBe(sendCountBefore);
    });

    it('terminates unresponsive Agent socket when Hub heartbeat sweep expires', async () => {
      const addr = server.address() as any;
      const rawKey = crypto.randomBytes(16).toString('base64');

      // Open a raw TCP WebSocket that completes the handshake but NEVER sends PONG frames
      const sock = net.createConnection(addr.port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        sock.once('connect', () => {
          sock.write(
            [
              'GET /api/terminal/agent-ws?hostId=silent-agent&name=silent-agent HTTP/1.1',
              `Host: 127.0.0.1:${addr.port}`,
              'Upgrade: websocket',
              'Connection: Upgrade',
              `Sec-WebSocket-Key: ${rawKey}`,
              'Sec-WebSocket-Version: 13',
              '',
              '',
            ].join('\r\n')
          );
        });
        let headerBuf = '';
        const onData = (chunk: Buffer) => {
          headerBuf += chunk.toString('latin1');
          if (headerBuf.includes('\r\n\r\n')) {
            sock.removeListener('data', onData);
            if (!headerBuf.includes('101 Switching Protocols')) {
              return reject(new Error(`Unexpected handshake response: ${headerBuf}`));
            }
            resolve();
          }
        };
        sock.on('data', onData);
        sock.once('error', reject);
      });

      await waitFor(() => hostMgr.getHost('silent-agent')?.status === 'online');

      // Because raw TCP socket ignores pings, Hub heartbeat timeout (180ms) must mark agent offline and close socket
      let sockClosed = false;
      sock.on('close', () => {
        sockClosed = true;
      });
      await waitFor(() => hostMgr.getHost('silent-agent')?.status === 'offline' && sockClosed, 3000);
      expect(hostMgr.getHost('silent-agent')?.status).toBe('offline');
      sock.destroy();
    });
  });

  describe('exec-ws & StreamSessionManager binary stdin / out-of-band EOF', () => {
    it('delivers exact binary bytes including 0x03, 0x04, 0x0d through InteractivePipeDriver + endInput', async () => {
      const messages: any[] = [];
      const outputChunks: Buffer[] = [];
      let exitInfo: any = null;

      const mgr = new StreamSessionManager((payload: any) => {
        if (Buffer.isBuffer(payload)) {
          const decoded = decodeBinaryPacket(payload);
          if (decoded?.msgType === BIN_MSG_TYPE.STREAM_OUTPUT) {
            outputChunks.push(decoded.payload);
          }
        } else {
          messages.push(payload);
          if (payload?.type === 'cmd_stream_exit') {
            exitInfo = payload;
          }
        }
      });

      const taskId = 'bin-stdin-task';
      const scriptCmd =
        `${JSON.stringify(process.execPath)} -e "const chunks=[]; process.stdin.on('data', c => chunks.push(c)); process.stdin.on('end', () => { process.stdout.write(Buffer.concat(chunks).toString('hex')); });"`;

      mgr.startStream({
        taskId,
        command: scriptCmd,
        tty: false,
        interactive: false,
        stdinEof: true,
        _forcePipeFallback: true,
      });

      const testBytes = Buffer.from([0x00, 0x03, 0x04, 0x0d, 0x0a, 0x7b, 0xfe, 0xff]);
      mgr.writeRawInput(taskId, testBytes);
      mgr.endInput(taskId);

      await waitFor(() => exitInfo !== null, 5000);
      expect(exitInfo.exitCode).toBe(0);
      expect(Buffer.concat(outputChunks).toString('utf-8')).toBe(testBytes.toString('hex'));
    });

    it('TerminalExecBridge passes non-control JSON stdin, handles exec_stdin_eof & ping, and avoids spurious kill', () => {
      const mockAgentWs = new EventEmitter() as any;
      mockAgentWs.readyState = 1;
      mockAgentWs.send = jest.fn();

      const { terminalHostManager } = require('../src/terminal/services/terminalHostManager');
      terminalHostManager.registerAgent({
        hostId: 'exec-v2-host',
        name: 'exec-v2-host',
        agentWs: mockAgentWs,
      });

      const mockCliWs = new EventEmitter() as any;
      mockCliWs.readyState = 1;
      mockCliWs.send = jest.fn();
      mockCliWs.close = jest.fn();

      terminalExecBridge.handleCliConnection(mockCliWs, {
        url: '/api/terminal/exec-ws?hostId=exec-v2-host',
        headers: { host: 'localhost' },
      } as any);

      // Simulate text-frame exec_start (isBinary = false)
      mockCliWs.emit(
        'message',
        Buffer.from(JSON.stringify({ type: 'exec_start', command: 'cat', tty: false })),
        false
      );

      const startedCall = mockCliWs.send.mock.calls.find((c: any[]) =>
        String(c[0]).includes('"type":"exec_started"')
      );
      expect(startedCall).toBeDefined();
      const started = JSON.parse(startedCall[0]);
      expect(started.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(started.capabilities?.stdinEof).toBe(true);

      // Ping -> Pong
      mockCliWs.emit('message', Buffer.from(JSON.stringify({ type: 'ping' })), false);
      expect(mockCliWs.send).toHaveBeenCalledWith(JSON.stringify({ type: 'pong' }));

      // Non-control JSON text frame must be passed through as STREAM_INPUT
      const userJson = '{"type":"custom_user_event","value":42}';
      mockCliWs.emit('message', Buffer.from(userJson), false);
      const streamInputCall = mockAgentWs.send.mock.calls.find(
        (c: any[]) => Buffer.isBuffer(c[0]) && c[0][0] === BIN_MSG_TYPE.STREAM_INPUT
      );
      expect(streamInputCall).toBeDefined();
      expect(decodeBinaryPacket(streamInputCall[0])?.payload.toString('utf-8')).toBe(userJson);

      // Binary frame mimicking exec_stdin_eof JSON must be passed through untouched as STREAM_INPUT
      const spoofedBinary = Buffer.from(JSON.stringify({ type: 'exec_stdin_eof' }));
      mockCliWs.emit('message', spoofedBinary, true);
      const binaryCalls = mockAgentWs.send.mock.calls.filter(
        (c: any[]) => Buffer.isBuffer(c[0]) && c[0][0] === BIN_MSG_TYPE.STREAM_INPUT
      );
      expect(binaryCalls.length).toBe(2);
      expect(decodeBinaryPacket(binaryCalls[1][0])?.payload).toEqual(spoofedBinary);

      // Control exec_stdin_eof text frame translates to cmd_stream_eof
      mockCliWs.emit('message', Buffer.from(JSON.stringify({ type: 'exec_stdin_eof' })), false);
      const eofCall = mockAgentWs.send.mock.calls.find(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('"type":"cmd_stream_eof"')
      );
      expect(eofCall).toBeDefined();

      // Clean exit must NOT send cmd_stream_kill when ws closes afterward
      terminalExecBridge.handleAgentStreamMessage('exec-v2-host', {
        type: 'cmd_stream_exit',
        taskId: started.taskId,
        exitCode: 0,
      });
      mockCliWs.emit('close');

      const killCalls = mockAgentWs.send.mock.calls.filter(
        (c: any[]) => typeof c[0] === 'string' && c[0].includes('"type":"cmd_stream_kill"')
      );
      expect(killCalls.length).toBe(0);
      terminalHostManager.unregisterAgent('exec-v2-host', mockAgentWs);
    });

    it('gt CLI exec -i negotiates exec_stdin_eof on v2 Hub and sends exact binary stdin without extra 0x04 or ?key= leak', async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });
      const wss = new WebSocketServer({ server });
      let receivedUrl = '';
      let receivedAuthHeader = '';
      const receivedStdinChunks: Buffer[] = [];
      let receivedStdinEofCtrl = false;

      wss.on('connection', (ws, req) => {
        receivedUrl = req.url || '';
        receivedAuthHeader = String(req.headers['x-admin-key'] || '');
        ws.on('message', (data: Buffer, isBinary: boolean) => {
          if (!isBinary) {
            const msg = JSON.parse(data.toString('utf-8'));
            if (msg.type === 'exec_start') {
              ws.send(
                JSON.stringify({
                  type: 'exec_started',
                  taskId: 'mock-task-v2',
                  protocolVersion: 2,
                  capabilities: { stdinEof: true, binaryStdin: true },
                })
              );
            } else if (msg.type === 'exec_stdin_eof') {
              receivedStdinEofCtrl = true;
              const combined = Buffer.concat(receivedStdinChunks);
              ws.send(Buffer.from(combined.toString('hex')), { binary: true });
              ws.send(JSON.stringify({ type: 'exec_exit', exitCode: 0, signal: null }));
            }
          } else {
            receivedStdinChunks.push(data);
          }
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;

      try {
        const binaryInput = Buffer.from([0x01, 0x03, 0x04, 0x0d, 0x0a, 0xde, 0xad, 0xbe, 0xef]);
        const child = spawn(
          process.execPath,
          [GT_BIN, '--server', `http://127.0.0.1:${port}`, '--key', 'top-secret-key', 'exec', '-i', 'node1', 'cat'],
          { stdio: ['pipe', 'pipe', 'pipe'] }
        );

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += d.toString('utf-8')));
        child.stderr.on('data', (d) => (stderr += d.toString('utf-8')));

        child.stdin.write(binaryInput);
        child.stdin.end();

        const exitCode = await new Promise<number>((resolve) => {
          child.on('exit', (code) => resolve(code ?? 1));
        });

        expect(exitCode).toBe(0);
        expect(stderr).toBe('');
        expect(receivedStdinEofCtrl).toBe(true);
        expect(Buffer.concat(receivedStdinChunks)).toEqual(binaryInput);
        expect(stdout).toBe(binaryInput.toString('hex'));
        expect(receivedUrl).not.toContain('top-secret-key');
        expect(receivedAuthHeader).toBe('top-secret-key');
      } finally {
        wss.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('gt CLI exec -i falls back to 0x04 on v1 server without capabilities and propagates exec_error exitCode', async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(404);
        res.end();
      });
      const wss = new WebSocketServer({ server });
      let receivedChunks: Buffer[] = [];
      let sawEotByte = false;

      wss.on('connection', (ws) => {
        ws.on('message', (data: Buffer, isBinary: boolean) => {
          if (!isBinary) {
            const msg = JSON.parse(data.toString('utf-8'));
            if (msg.type === 'exec_start') {
              if (msg.command.includes('trigger-err')) {
                ws.send(JSON.stringify({ type: 'exec_error', error: 'Denied', exitCode: 3 }));
                ws.close(1008, 'Denied');
              } else {
                // v1 server omitting capabilities.stdinEof
                ws.send(JSON.stringify({ type: 'exec_started', taskId: 'v1-task' }));
              }
            }
          } else {
            receivedChunks.push(data);
            if (data.includes(0x04)) {
              sawEotByte = true;
              ws.send(Buffer.from('ok'), { binary: true });
              ws.send(JSON.stringify({ type: 'exec_exit', exitCode: 0, signal: null }));
            }
          }
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;

      try {
        const childV1 = spawn(
          process.execPath,
          [GT_BIN, '--server', `http://127.0.0.1:${port}`, '--key', 'k', 'exec', '-i', 'node1', 'cat'],
          { stdio: ['pipe', 'pipe', 'pipe'] }
        );
        let outV1 = '';
        childV1.stdout.on('data', (d) => (outV1 += d.toString('utf-8')));
        childV1.stdin.end('hello');
        const codeV1 = await new Promise<number>((resolve) => childV1.on('exit', (c) => resolve(c ?? 1)));
        expect(codeV1).toBe(0);
        expect(sawEotByte).toBe(true);
        expect(outV1).toBe('ok');

        const childErr = spawn(
          process.execPath,
          [GT_BIN, '--server', `http://127.0.0.1:${port}`, '--key', 'k', 'exec', 'node1', 'trigger-err'],
          { stdio: ['ignore', 'pipe', 'pipe'] }
        );
        let errText = '';
        childErr.stderr.on('data', (d) => (errText += d.toString('utf-8')));
        const codeErr = await new Promise<number>((resolve) => childErr.on('exit', (c) => resolve(c ?? 1)));
        expect(codeErr).toBe(3);
        expect(errText).toContain('Denied');
      } finally {
        wss.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('proxy-ws dynamic routing, validation, and CliTcpTunnelClient', () => {
    it('routes dynamically across agent reconnects, validates streamId/port, and enforces pendingWrite cap', async () => {
      const { terminalHostManager } = require('../src/terminal/services/terminalHostManager');
      const server = http.createServer();
      const wss = setupTerminalWebSocket(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;

      const agent1 = new EventEmitter() as any;
      agent1.readyState = 1;
      agent1.send = jest.fn();
      terminalHostManager.registerAgent({ hostId: 'proxy-dyn-host', name: 'proxy-dyn-host', agentWs: agent1 });

      const client = new CliTcpTunnelClient({
        serverUrl: `http://127.0.0.1:${port}`,
        apiKey: config.adminSecretKey || 'dev-key',
        hostId: 'proxy-dyn-host',
      });
      await client.connect();

      // Re-register host with a NEW agent socket while proxy-ws stays open
      const agent2 = new EventEmitter() as any;
      agent2.readyState = 1;
      agent2.send = jest.fn();
      terminalHostManager.registerAgent({ hostId: 'proxy-dyn-host', name: 'proxy-dyn-host', agentWs: agent2 });

      const onCloseMock = jest.fn();
      const handle = client.openStream('127.0.0.1', 8080, jest.fn(), onCloseMock);

      await waitFor(() =>
        agent2.send.mock.calls.some((c: any[]) => String(c[0]).includes('proxy_tcp_connect'))
      );
      expect(agent1.send).not.toHaveBeenCalled();

      // Exceeding 2MB pre-connect pending write cap triggers graceful stream close instead of OOM
      handle.write(Buffer.alloc(1024 * 1024 + 1));
      handle.write(Buffer.alloc(1024 * 1024 + 1));
      expect(onCloseMock).toHaveBeenCalledWith(expect.stringContaining('overflow'));

      // Direct bridge validation against invalid port & oversized streamId
      const rawWs = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/proxy-ws?hostId=proxy-dyn-host`, {
        headers: { 'x-admin-key': config.adminSecretKey || '' },
      });
      const responses: any[] = [];
      await new Promise<void>((resolve) => rawWs.once('open', resolve));
      rawWs.on('message', (d: any) => {
        const s = d.toString('utf-8');
        if (s.startsWith('JSON:')) responses.push(JSON.parse(s.slice(5)));
      });
      rawWs.send(`JSON:${JSON.stringify({ type: 'ping' })}`);
      rawWs.send(`JSON:${JSON.stringify({ type: 'proxy_tcp_connect', streamId: 'x'.repeat(260), host: '127.0.0.1', port: 80 })}`);
      rawWs.send(`JSON:${JSON.stringify({ type: 'proxy_tcp_connect', streamId: 'ok-id', host: '127.0.0.1', port: 70000 })}`);

      await waitFor(() => responses.length >= 3);
      expect(responses[0]).toEqual({ type: 'pong' });
      expect(responses[1]).toMatchObject({ type: 'proxy_tcp_close', code: 'EINVAL' });
      expect(responses[2]).toMatchObject({ type: 'proxy_tcp_close', streamId: 'ok-id', code: 'EINVAL' });

      rawWs.close();
      client.close();
      terminalHostManager.unregisterAgent('proxy-dyn-host', agent2);
      try {
        (wss as any).closeAllClients?.(1001, 'Done');
        wss.close();
      } catch {}
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  });

  describe('Client HTTP helpers & interactiveExec robustness', () => {
    it('makeRequest decompresses gzip JSON, enforces timeout, and resolveWebSocketUrl preserves subpath', async () => {
      const server = http.createServer((req, res) => {
        if (req.url === '/api/gzip') {
          const payload = JSON.stringify({ success: true, message: '压缩响应你好世界' });
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Encoding': 'gzip',
          });
          res.end(zlib.gzipSync(Buffer.from(payload, 'utf-8')));
          return;
        }
        if (req.url === '/api/slow') {
          // Never respond quickly
          setTimeout(() => {
            if (!res.writableEnded) {
              res.writeHead(200);
              res.end('{}');
            }
          }, 1500).unref();
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;

      try {
        const res = await makeRequest({
          serverUrl: `http://127.0.0.1:${port}`,
          endpoint: '/api/gzip',
        });
        expect(res.status).toBe(200);
        expect(res.data).toEqual({ success: true, message: '压缩响应你好世界' });

        await expect(
          makeRequest({
            serverUrl: `http://127.0.0.1:${port}`,
            endpoint: '/api/slow',
            timeoutMs: 80,
          })
        ).rejects.toThrow(/timeout/i);

        const wsUrl = resolveWebSocketUrl('https://hub.example.com:8443/subpath/', {
          hostId: 'h-1',
          protocolVersion: 2,
          key: 'must-strip',
          timezone: 'Asia/Shanghai',
        });
        expect(wsUrl).toBe('wss://hub.example.com:8443/subpath/api/terminal/agent-ws?hostId=h-1&protocolVersion=2');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('resolveHost prefers online host among duplicate/prefix matches while rejecting ambiguous online nodes', async () => {
      let hostsPayload: any[] = [
        { id: 'old-web-1', name: 'web-node', status: 'offline' },
        { id: 'live-web-2', name: 'web-node', status: 'online' },
        { id: 'box-alpha', name: 'box-alpha', status: 'offline' },
        { id: 'box-beta', name: 'box-beta', status: 'online' },
      ];

      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, hosts: hostsPayload }));
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;

      try {
        const pickedExact = await resolveHost(`http://127.0.0.1:${port}`, '', 'web-node');
        expect(pickedExact.id).toBe('live-web-2');

        const pickedPrefix = await resolveHost(`http://127.0.0.1:${port}`, '', 'box');
        expect(pickedPrefix.id).toBe('box-beta');

        hostsPayload = [
          { id: 'box-1', name: 'box-one', status: 'online' },
          { id: 'box-2', name: 'box-two', status: 'online' },
        ];
        await expect(resolveHost(`http://127.0.0.1:${port}`, '', 'box')).rejects.toThrow(/Ambiguous host/i);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('runInteractiveExec resolves cleanly on code 1000 close without exec_exit and removes process listeners', async () => {
      const server = http.createServer();
      const wss = new WebSocketServer({ server });
      wss.on('connection', (ws) => {
        ws.on('message', () => {
          ws.send(JSON.stringify({ type: 'exec_started', taskId: 'it-1' }));
          ws.close(1000, 'Clean close without exec_exit');
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;

      const sigintBefore = process.listenerCount('SIGINT');
      const stdinBefore = process.stdin.listenerCount('data');
      const resizeBefore = process.stdout.listenerCount('resize');

      try {
        const code = await runInteractiveExec({
          serverUrl: `http://127.0.0.1:${port}`,
          apiKey: '',
          hostId: 'node-1',
          fullCommand: 'bash',
          options: { tty: false },
        });
        expect(code).toBe(0);
        expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
        expect(process.stdin.listenerCount('data')).toBe(stdinBefore);
        expect(process.stdout.listenerCount('resize')).toBe(resizeBefore);
      } finally {
        wss.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  describe('Reviewer audit fixes verification', () => {
    it('StreamSessionManager preserves exact raw non-UTF8 binary stdout when tty=false', async () => {
      const outputChunks: Buffer[] = [];
      let exitInfo: any = null;
      const mgr = new StreamSessionManager((payload) => {
        if (Buffer.isBuffer(payload)) {
          const decoded = decodeBinaryPacket(payload);
          if (decoded && decoded.msgType === BIN_MSG_TYPE.STREAM_OUTPUT) {
            outputChunks.push(decoded.payload);
          }
        } else if (payload?.type === 'cmd_stream_exit') {
          exitInfo = payload;
        }
      });

      const taskId = 'raw-stdout-task';
      const expected = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x81, 0x41]);
      const scriptCmd = `${JSON.stringify(process.execPath)} -e "process.stdout.write(Buffer.from([0xff,0xfe,0x00,0x80,0x81,0x41]))"`;
      mgr.startStream({
        taskId,
        command: scriptCmd,
        tty: false,
        interactive: false,
        stdinEof: true,
        _forcePipeFallback: true,
      });

      await waitFor(() => exitInfo !== null, 5000);
      expect(exitInfo.exitCode).toBe(0);
      expect(Buffer.concat(outputChunks)).toEqual(expected);
    });

    it('gt exec -i waits for delayed exec_started before sending stdin and never injects literal 0x04', async () => {
      const receivedStdin: Buffer[] = [];
      let receivedEof = false;

      const server = http.createServer((req, res) => {
        if (req.url?.startsWith('/api/hosts')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, hosts: [{ id: 'delay-host', name: 'node-delay', status: 'online' }] }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const wss = new WebSocketServer({ server, path: '/api/terminal/exec-ws' });
      wss.on('connection', (ws) => {
        ws.on('message', (data: any, isBinary: boolean) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          if (!isBinary) {
            const msg = JSON.parse(buf.toString('utf-8'));
            if (msg.type === 'exec_start') {
              setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: 'exec_started',
                      taskId: 'delay-1',
                      protocolVersion: 2,
                      capabilities: { stdinEof: true, binaryStdin: true, binaryControl: false },
                    })
                  );
                }
              }, 220);
            } else if (msg.type === 'exec_stdin_eof') {
              receivedEof = true;
              ws.send(JSON.stringify({ type: 'exec_exit', exitCode: 0 }));
            }
          } else {
            receivedStdin.push(buf);
          }
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;
      const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-delay-exec-'));

      try {
        const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [GT_BIN, 'exec', '-i', 'node-delay', 'cat'],
            {
              env: {
                ...process.env,
                GT_CONFIG_DIR: tmpConfigDir,
                GT_SERVER: `http://127.0.0.1:${port}`,
                GT_KEY: 'test-secret',
              },
              stdio: ['pipe', 'pipe', 'pipe'],
            }
          );
          let stderr = '';
          child.stderr.on('data', (c) => { stderr += c.toString('utf-8'); });
          child.stdin.write('hello');
          child.stdin.end();
          child.on('error', reject);
          child.on('close', (code) => resolve({ code, stderr }));
        });

        expect(result.code).toBe(0);
        expect(receivedEof).toBe(true);
        expect(Buffer.concat(receivedStdin)).toEqual(Buffer.from('hello', 'utf-8'));
      } finally {
        try { fs.rmSync(tmpConfigDir, { recursive: true, force: true }); } catch {}
        wss.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('runInteractiveExec wraps pasted control JSON as binary frames and TerminalExecBridge keeps binaryControl=false', async () => {
      const receivedFrames: Array<{ data: Buffer; isBinary: boolean }> = [];
      const server = http.createServer();
      const wss = new WebSocketServer({ server });
      const activeSockets = new Set<WebSocket>();

      wss.on('connection', (ws) => {
        activeSockets.add(ws);
        ws.on('message', (data: any, isBinary: boolean) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          receivedFrames.push({ data: buf, isBinary });
          if (!isBinary) {
            const parsed = JSON.parse(buf.toString('utf-8'));
            if (parsed.type === 'exec_start') {
              ws.send(JSON.stringify({
                type: 'exec_started',
                taskId: 'it-bin-wrap',
                protocolVersion: 2,
                capabilities: { stdinEof: true, binaryStdin: true, binaryControl: false },
              }));
            }
          } else if (buf.toString('utf-8') === '{"type":"exec_kill"}') {
            ws.send(JSON.stringify({ type: 'exec_exit', exitCode: 0 }));
          }
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;

      try {
        const execPromise = runInteractiveExec({
          serverUrl: `http://127.0.0.1:${port}`,
          apiKey: '',
          hostId: 'node-1',
          fullCommand: 'cat',
          options: { tty: false },
        });

        await waitFor(() => receivedFrames.length >= 1 && process.stdin.listenerCount('data') > 0);
        // Simulate pasted JSON control payload arriving from stdin during interactive session
        process.stdin.emit('data', Buffer.from('{"type":"exec_kill"}'));

        const code = await execPromise;
        expect(code).toBe(0);
        const binaryStdinFrame = receivedFrames.find((f) => f.isBinary && f.data.toString('utf-8') === '{"type":"exec_kill"}');
        expect(binaryStdinFrame).toBeDefined();

        // Also confirm TerminalExecBridge advertises binaryControl=false and passes 0x08 binary frames untouched
        const mockAgentWs = new EventEmitter() as any;
        mockAgentWs.readyState = 1;
        mockAgentWs.send = jest.fn();
        terminalHostManager.registerAgent({ hostId: 'exec-raw-host', name: 'exec-raw-host', agentWs: mockAgentWs });

        const mockCliWs = new EventEmitter() as any;
        mockCliWs.readyState = 1;
        mockCliWs.send = jest.fn();
        mockCliWs.close = jest.fn();
        terminalExecBridge.handleCliConnection(mockCliWs, {
          url: '/api/terminal/exec-ws?hostId=exec-raw-host&binaryControl=1',
          headers: { host: 'localhost' },
        } as any);
        mockCliWs.emit('message', Buffer.from(JSON.stringify({ type: 'exec_start', command: 'cat', tty: false })), false);
        const startedMsg = JSON.parse(mockCliWs.send.mock.calls.find((c: any[]) => String(c[0]).includes('exec_started'))[0]);
        expect(startedMsg.capabilities.binaryControl).toBe(false);

        const spoofedCtrlPkt = encodeControlJsonPacket({ type: 'exec_kill' }, 'x');
        mockCliWs.emit('message', spoofedCtrlPkt, true);
        const forwarded = mockAgentWs.send.mock.calls.find(
          (c: any[]) => Buffer.isBuffer(c[0]) && c[0][0] === BIN_MSG_TYPE.STREAM_INPUT
        );
        expect(forwarded).toBeDefined();
        expect(decodeBinaryPacket(forwarded[0])?.payload).toEqual(spoofedCtrlPkt);
        const killCalls = mockAgentWs.send.mock.calls.filter(
          (c: any[]) => typeof c[0] === 'string' && c[0].includes('cmd_stream_kill')
        );
        expect(killCalls.length).toBe(0);

        mockCliWs.emit('close');
        terminalHostManager.unregisterAgent('exec-raw-host', mockAgentWs);
      } finally {
        for (const ws of activeSockets) {
          try { ws.close(); } catch {}
        }
        wss.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('RemoteAgentTerminalSession wraps flushed pendingInputBuffer and Buffer writes in TERMINAL_RAW/STREAM_INPUT', () => {
      const hostMgr = new TerminalHostManager();
      const offlineWs = new EventEmitter() as any;
      offlineWs.readyState = 1;
      offlineWs.send = jest.fn();
      hostMgr.registerAgent({ hostId: 'flush-host', name: 'flush-host', agentWs: offlineWs });
      const mainSession = hostMgr.getSession('flush-host', 'main')!;
      hostMgr.unregisterAgent('flush-host', offlineWs);

      mainSession.write('abc');
      mainSession.write(Buffer.from([0x03, 0xff]) as any);

      const sent: any[] = [];
      const agentWs = new EventEmitter() as any;
      agentWs.readyState = 1;
      agentWs._framedTerminal = true;
      agentWs._binaryControl = true;
      agentWs.send = jest.fn((payload: any) => sent.push(payload));

      hostMgr.registerAgent({ hostId: 'flush-host', name: 'flush-host', agentWs });

      const mainRawPkts = sent
        .filter((p) => Buffer.isBuffer(p))
        .map((p) => decodeBinaryPacket(p))
        .filter((d) => d && d.msgType === BIN_MSG_TYPE.TERMINAL_RAW && d.id === 'main');
      expect(mainRawPkts.length).toBe(2);
      expect(mainRawPkts[0]!.payload).toEqual(Buffer.from('abc', 'utf-8'));
      expect(mainRawPkts[1]!.payload).toEqual(Buffer.from([0x03, 0xff]));

      // Secondary pane offline pendingInputBuffer flushes as STREAM_INPUT when agent reconnects
      sent.length = 0;
      const paneSession = new RemoteAgentTerminalSession('flush-host', null, 'pane-1');
      paneSession.write('ls\n');
      paneSession.updateAgentWs(agentWs);
      const panePkts = sent
        .filter((p) => Buffer.isBuffer(p))
        .map((p) => decodeBinaryPacket(p))
        .filter((d) => d && d.msgType === BIN_MSG_TYPE.STREAM_INPUT && d.id === 'pane-pane-1');
      expect(panePkts.length).toBe(1);
      expect(panePkts[0]!.payload).toEqual(Buffer.from('ls\n', 'utf-8'));
      paneSession.destroy();

      // Direct Buffer write while connected also respects _framedTerminal
      sent.length = 0;
      const directSession = new RemoteAgentTerminalSession('direct-host', agentWs, 'main');
      directSession.write(Buffer.from([0x01, 0x08]) as any);
      const directDecoded = decodeBinaryPacket(sent[0]);
      expect(directDecoded?.msgType).toBe(BIN_MSG_TYPE.TERMINAL_RAW);
      expect(directDecoded?.id).toBe('main');
      expect(directDecoded?.payload).toEqual(Buffer.from([0x01, 0x08]));
      directSession.destroy();

      hostMgr.unregisterAgent('flush-host', agentWs);
    });

    it('RpcDispatcher fails fast when agent socket send fails instead of hanging until timeout', async () => {
      const brokenWs = {
        readyState: 1,
        send: jest.fn(() => { throw new Error('EPIPE'); }),
      };
      const session = { getAgentWs: () => brokenWs };
      const cmdRes = await rpcDispatcher.executeCmdRpc(session, 'broken-host', { action: 'list' }, 10000);
      expect(cmdRes.success).toBe(false);
      expect(cmdRes.error).toMatch(/Failed to dispatch/i);

      const fileRes = await rpcDispatcher.executeFileRpc(session, 'broken-host', { action: 'stat', path: '/tmp' }, 10000);
      expect(fileRes.success).toBe(false);
      expect(fileRes.error).toMatch(/Failed to dispatch/i);
    });

    it('TerminalProxyBridge enforces stream ownership, rejects duplicate streamIds with EEXIST, and uses CONTROL_JSON on disconnect', async () => {
      config.adminSecretKey = '';
      const server = http.createServer();
      const wss = setupTerminalWebSocket(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;

      const agentSent: any[] = [];
      const agentWs = new EventEmitter() as any;
      agentWs.readyState = 1;
      agentWs._binaryControl = true;
      agentWs._sender = {};
      agentWs.send = jest.fn((p: any) => agentSent.push(p));
      terminalHostManager.registerAgent({ hostId: 'proxy-own-host', name: 'proxy-own-host', agentWs });

      const cli1 = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/proxy-ws?hostId=proxy-own-host&binaryControl=1`);
      const cli2 = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/proxy-ws?hostId=proxy-own-host`);
      const cli1Msgs: any[] = [];
      cli1.on('message', (d: any, isBinary: boolean) => {
        if (isBinary) {
          const decoded = decodeControlJsonPacket(Buffer.from(d));
          if (decoded) cli1Msgs.push(decoded);
        }
      });

      try {
        await Promise.all([
          new Promise<void>((r, rej) => {
            cli1.once('open', () => r());
            cli1.once('error', rej);
          }),
          new Promise<void>((r, rej) => {
            cli2.once('open', () => r());
            cli2.once('error', rej);
          }),
        ]);
        cli1.send(encodeControlJsonPacket({ type: 'proxy_tcp_connect', streamId: 'own-s1', host: '127.0.0.1', port: 9000 }, 'proxy-own-host'), { binary: true });
        await waitFor(() => agentSent.some((p) => Buffer.isBuffer(p) && decodeControlJsonPacket(p)?.type === 'proxy_tcp_connect'));

        // Duplicate streamId rejected with EEXIST
        cli1.send(encodeControlJsonPacket({ type: 'proxy_tcp_connect', streamId: 'own-s1', host: '127.0.0.1', port: 9000 }, 'proxy-own-host'), { binary: true });
        await waitFor(() => cli1Msgs.some((m) => m.code === 'EEXIST'));

        // cli2 cannot send data or close on cli1's streamId
        const sentBeforeSpoof = agentSent.length;
        cli2.send(encodeBinaryPacket(BIN_MSG_TYPE.PROXY_TCP_DATA, 'own-s1', Buffer.from('spoof')), { binary: true });
        cli2.send(`JSON:${JSON.stringify({ type: 'proxy_tcp_close', streamId: 'own-s1' })}`);
        await new Promise((r) => setTimeout(r, 80));
        expect(agentSent.length).toBe(sentBeforeSpoof);

        // Agent disconnect notifies cli1 with CONTROL_JSON ECONNRESET
        terminalProxyBridge.handleAgentDisconnected('proxy-own-host');
        await waitFor(() => cli1Msgs.some((m) => m.type === 'proxy_tcp_close' && m.code === 'ECONNRESET'));
      } finally {
        cli1.close();
        cli2.close();
        terminalHostManager.unregisterAgent('proxy-own-host', agentWs);
        try {
          (wss as any).closeAllClients?.(1001, 'Done');
          wss.close();
        } catch {}
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('CliTcpTunnelClient fails offline openStream cleanly, resolveProxyWebSocketUrl keeps subpath, makeRequest decodes raw deflate, and cp fails immediately on write errors', async () => {
      // 1. resolveProxyWebSocketUrl subpath preservation
      expect(resolveProxyWebSocketUrl('https://example.com:8443/sub/path/', 'n1')).toBe(
        'wss://example.com:8443/sub/path/api/terminal/proxy-ws?hostId=n1'
      );

      // 2. CliTcpTunnelClient offline openStream invokes onClose
      const offlineClient = new CliTcpTunnelClient({
        serverUrl: 'http://127.0.0.1:1',
        apiKey: '',
        hostId: 'offline',
      });
      const onClose = jest.fn();
      offlineClient.openStream('127.0.0.1', 8080, jest.fn(), onClose);
      await waitFor(() => onClose.mock.calls.length > 0);
      expect(onClose).toHaveBeenCalledWith(expect.stringContaining('not connected'));

      // 3. makeRequest raw deflate & cp.ts immediate failure on disk write error (1 request, not 10 retries)
      let downloadAttempts = 0;
      const server = http.createServer((req, res) => {
        if (req.url === '/api/raw-deflate') {
          const payload = zlib.deflateRawSync(Buffer.from(JSON.stringify({ ok: true, mode: 'deflateRaw' })));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate' });
          res.end(payload);
          return;
        }
        if (req.url?.startsWith('/api/terminal/files/download')) {
          downloadAttempts++;
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '5' });
          res.end(Buffer.from('hello'));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cp-err-'));

      try {
        const rawDeflateRes = await makeRequest({
          serverUrl: `http://127.0.0.1:${port}`,
          endpoint: '/api/raw-deflate',
        });
        expect(rawDeflateRes.data).toEqual({ ok: true, mode: 'deflateRaw' });

        // Force fs.createWriteStream(partFile) to fail immediately with EISDIR
        const destFile = path.join(tmpDir, 'out.txt');
        fs.mkdirSync(`${destFile}.part`);
        await expect(
          downloadRemoteFile({
            serverUrl: `http://127.0.0.1:${port}`,
            apiKey: '',
            hostId: 'h1',
            remotePath: '/remote/out.txt',
            localPath: destFile,
          })
        ).rejects.toThrow(/Failed to write local file/i);
        expect(downloadAttempts).toBe(1);
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('live daemon process negotiates framedTerminal=1 and relays TERMINAL_RAW("main") through real Hub', async () => {
      config.adminSecretKey = '';
      const liveHostMgr = new TerminalHostManager();
      const server = http.createServer();
      const wss = setupTerminalWebSocket(server, liveHostMgr);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;
      const tmpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-live-agent-'));
      let agentChild: ReturnType<typeof spawn> | null = null;
      let browserWs: WebSocket | null = null;
      let agentStderr = '';

      try {
        agentChild = spawn(
          process.execPath,
          [
            GT_BIN,
            'agent',
            'start',
            '--internal-daemon',
            '--no-proxy',
            '--server',
            `http://127.0.0.1:${port}`,
            '--key',
            'dev-key',
          ],
          {
            env: {
              ...process.env,
              GT_CONFIG_DIR: tmpConfigDir,
              GT_AGENT_NAME: 'live-v2-node',
              GT_SERVER: `http://127.0.0.1:${port}`,
              GT_KEY: 'dev-key',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
        agentChild.stderr?.on('data', (c) => { agentStderr += c.toString('utf-8'); });

        try {
          await waitFor(() => {
            const online = liveHostMgr.getHosts().find((h) => h.name === 'live-v2-node' && h.status === 'online');
            return Boolean(online);
          }, 10000);
        } catch (err: any) {
          throw new Error(`${err.message}; agentStderr=${agentStderr}`);
        }

        const host = liveHostMgr.getHosts().find((h) => h.name === 'live-v2-node')!;
        const agentWs = liveHostMgr.getAgentWs(host.id);
        expect(agentWs).toBeTruthy();
        expect((agentWs as any)._framedTerminal).toBe(true);
        expect((agentWs as any)._binaryControl).toBe(true);

        let terminalOut = '';
        browserWs = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws?hostId=${encodeURIComponent(host.id)}`);
        browserWs.on('message', (data: any, isBinary: boolean) => {
          if (!isBinary) {
            const s = data.toString('utf-8');
            if (!s.startsWith('JSON:')) terminalOut += s;
          } else {
            terminalOut += Buffer.from(data).toString('utf-8');
          }
        });
        await new Promise<void>((resolve) => browserWs!.once('open', resolve));

        browserWs.send('echo GT_V2_LIVE_ROUNDTRIP\r');
        await waitFor(() => terminalOut.includes('GT_V2_LIVE_ROUNDTRIP'), 10000);
        expect(terminalOut).toContain('GT_V2_LIVE_ROUNDTRIP');
      } finally {
        try { browserWs?.close(); } catch {}
        if (agentChild && !agentChild.killed) {
          try { agentChild.kill('SIGTERM'); } catch {}
          await new Promise<void>((resolve) => {
            const t = setTimeout(() => {
              try { agentChild?.kill('SIGKILL'); } catch {}
              resolve();
            }, 1500);
            agentChild!.once('exit', () => {
              clearTimeout(t);
              resolve();
            });
          });
        }
        try { fs.rmSync(tmpConfigDir, { recursive: true, force: true }); } catch {}
        try {
          (wss as any).closeAllClients?.(1001, 'Done');
          wss.close();
        } catch {}
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 20000);
  });

  describe('Protocol Gap Remediation Verification', () => {
    it('exec.ts does not fall back to HTTP poll after exec_started (1001/close/error) or on 401/403/429 upgrade rejections, but falls back pre-exec_started', async () => {
      let mode: 'post-start-1001' | 'post-start-drop' | 'upgrade-401' | 'upgrade-403' | 'upgrade-429' | 'pre-start-close' = 'post-start-1001';
      let httpExecPostCount = 0;

      const server = http.createServer((req, res) => {
        if (req.url?.startsWith('/api/terminal/hosts')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ hosts: [{ id: 'n1', name: 'n1', status: 'online' }] }));
          return;
        }
        if (req.method === 'POST' && req.url?.startsWith('/api/terminal/exec/n1')) {
          httpExecPostCount++;
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, taskId: 'poll-task-1' }));
          return;
        }
        if (req.method === 'GET' && req.url?.includes('/api/terminal/exec/n1/poll-task-1')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            status: 'completed',
            exitCode: 0,
            stdout: 'poll-fallback-ok\n',
            stderr: '',
            outputOffset: 17,
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', (req, socket, head) => {
        if (mode === 'upgrade-401') {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        if (mode === 'upgrade-403') {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        if (mode === 'upgrade-429') {
          socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      });

      wss.on('connection', (ws) => {
        ws.on('message', (data: Buffer, isBinary: boolean) => {
          if (isBinary) {
            if (mode === 'post-start-1001') {
              ws.close(1001, 'Server shutting down');
            } else if (mode === 'post-start-drop') {
              ws.terminate();
            }
            return;
          }
          const msg = JSON.parse(data.toString('utf-8'));
          if (msg.type === 'exec_start') {
            if (mode === 'pre-start-close') {
              ws.close(1011, 'Pre-start failure');
              return;
            }
            ws.send(JSON.stringify({
              type: 'exec_started',
              taskId: 't-post-1',
              protocolVersion: 2,
              capabilities: { stdinEof: true, binaryStdin: true },
            }));
          } else if (msg.type === 'exec_stdin_eof' && mode === 'post-start-1001') {
            ws.close(1001, 'Server shutting down');
          }
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;
      const serverUrl = `http://127.0.0.1:${port}`;

      const spawnGt = (args: string[], stdinText?: string) =>
        new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, [GT_BIN, '--server', serverUrl, '--key', 'k', ...args], {
            stdio: [stdinText !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout?.on('data', (c) => (stdout += c.toString('utf-8')));
          child.stderr?.on('data', (c) => (stderr += c.toString('utf-8')));
          child.on('error', reject);
          child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
          if (stdinText !== undefined) {
            child.stdin!.end(stdinText);
          }
        });

      try {
        // 1) Post-exec_started 1001 disconnect must NOT fall back to HTTP poll
        mode = 'post-start-1001';
        httpExecPostCount = 0;
        let postErr: any = null;
        try {
          await runStreamExec({
            serverUrl,
            apiKey: 'k',
            hostId: 'n1',
            fullCommand: 'cat',
            options: { detach: false, timeoutMs: 5000, verbose: false, pollInterval: 50, env: {}, interactive: true, tty: false, mode: 'stream' },
            stdinPayload: 'abc',
            startTime: Date.now(),
          });
        } catch (err) {
          postErr = err;
        }
        expect(postErr).toBeInstanceOf(StreamExecError);
        expect(postErr.allowHttpFallback).toBe(false);

        const cliPost1001 = await spawnGt(['exec', '-i', 'n1', 'cat'], 'payload-already-consumed');
        expect(cliPost1001.code).toBe(1);
        expect(httpExecPostCount).toBe(0);

        // 1b) Post-exec_started abnormal socket drop (1006) must NOT fall back to HTTP poll
        mode = 'post-start-drop';
        httpExecPostCount = 0;
        const cliPostDrop = await spawnGt(['exec', '-i', 'n1', 'cat'], 'payload-already-consumed');
        expect(cliPostDrop.code).toBe(1);
        expect(httpExecPostCount).toBe(0);

        // 2) HTTP 401/403/429 upgrade rejections must NOT fall back to duplicate HTTP requests
        for (const m of ['upgrade-401', 'upgrade-403', 'upgrade-429'] as const) {
          mode = m;
          httpExecPostCount = 0;
          const expectedStatus = Number(m.split('-')[1]);
          await expect(
            runStreamExec({
              serverUrl,
              apiKey: 'k',
              hostId: 'n1',
              fullCommand: 'echo hi',
              options: { detach: false, timeoutMs: 5000, verbose: false, pollInterval: 50, env: {}, interactive: false, tty: false, mode: 'stream' },
              startTime: Date.now(),
            })
          ).rejects.toMatchObject({ allowHttpFallback: false, statusCode: expectedStatus });

          const cliRejected = await spawnGt(['exec', 'n1', 'echo', 'hi']);
          expect(cliRejected.code).toBe(1);
          expect(cliRejected.stderr).toContain(String(expectedStatus));
          expect(httpExecPostCount).toBe(0);
        }

        // 3) Pre-exec_started abnormal close still allows HTTP poll fallback
        mode = 'pre-start-close';
        httpExecPostCount = 0;
        const cliPreStartFallback = await spawnGt(['exec', '-i', 'n1', 'cat'], 'ok');
        expect(cliPreStartFallback.code).toBe(0);
        expect(cliPreStartFallback.stdout).toContain('poll-fallback-ok');
        expect(httpExecPostCount).toBe(1);
      } finally {
        wss.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('interactiveExec defers stdin until exec_started, handles stdinEof / 0x04, unexpected-response, stderr Host Offline, and SIGTERM exec_kill', async () => {
      let behavior: 'delayed-v2' | 'v1-eot' | 'upgrade-401' | 'host-offline' | 'kill-on-sigterm' = 'delayed-v2';
      let lastStdinBytes = Buffer.alloc(0);
      let sawExecStdinEof = false;
      let sawKillSignal: string | null = null;
      let sawClientClose = false;

      const server = http.createServer((req, res) => {
        if (req.url?.startsWith('/api/terminal/hosts')) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ hosts: [{ id: 'it-node', name: 'it-node', status: 'online' }] }));
          return;
        }
        res.writeHead(404);
        res.end();
      });

      const wss = new WebSocketServer({ noServer: true });
      server.on('upgrade', (req, socket, head) => {
        if (behavior === 'upgrade-401') {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      });

      wss.on('connection', (ws) => {
        const chunks: Buffer[] = [];
        if (behavior === 'host-offline') {
          ws.send('\r\n\x1b[33m[Host Offline] Host "it-node" is offline or unavailable.\x1b[0m\r\n', { binary: false });
          ws.close(1008, 'Host is offline or unavailable');
          return;
        }

        ws.on('message', (data: Buffer, isBinary: boolean) => {
          if (isBinary) {
            chunks.push(Buffer.from(data));
            if (behavior === 'v1-eot' && data.includes(0x04)) {
              lastStdinBytes = Buffer.concat(chunks);
              ws.send(JSON.stringify({ type: 'exec_exit', exitCode: 0 }));
            }
            return;
          }
          const msg = JSON.parse(data.toString('utf-8'));
          if (msg.type === 'exec_start') {
            if (behavior === 'delayed-v2') {
              setTimeout(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    type: 'exec_started',
                    taskId: 'it-v2-1',
                    protocolVersion: 2,
                    capabilities: { stdinEof: true, binaryStdin: true },
                  }));
                }
              }, 160);
            } else if (behavior === 'v1-eot') {
              ws.send(JSON.stringify({ type: 'exec_started', taskId: 'it-v1-1' }));
            } else if (behavior === 'kill-on-sigterm') {
              ws.send(JSON.stringify({
                type: 'exec_started',
                taskId: 'it-kill-1',
                protocolVersion: 2,
                capabilities: { stdinEof: true },
              }));
              ws.send(Buffer.from('READY\n'), { binary: true });
            }
          } else if (msg.type === 'exec_stdin_eof') {
            sawExecStdinEof = true;
            lastStdinBytes = Buffer.concat(chunks);
            ws.send(Buffer.from(lastStdinBytes.toString('hex')), { binary: true });
            ws.send(JSON.stringify({ type: 'exec_exit', exitCode: 0 }));
          } else if (msg.type === 'exec_kill') {
            sawKillSignal = msg.signal || null;
          }
        });

        ws.on('close', () => {
          sawClientClose = true;
        });
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;
      const serverUrl = `http://127.0.0.1:${port}`;

      try {
        // 1) Delayed exec_started: stdin listener NOT attached immediately on open
        behavior = 'delayed-v2';
        const baseStdinListeners = process.stdin.listenerCount('data');
        const interactivePromise = runInteractiveExec({
          serverUrl,
          apiKey: '',
          hostId: 'it-node',
          fullCommand: 'cat',
          options: { tty: false },
        });
        await new Promise((r) => setTimeout(r, 60));
        expect(process.stdin.listenerCount('data')).toBe(baseStdinListeners);
        await waitFor(() => process.stdin.listenerCount('data') === baseStdinListeners + 1);
        process.stdin.emit('data', Buffer.from([0x04, 0x41]));
        process.stdin.emit('end');
        const delayedCode = await interactivePromise;
        expect(delayedCode).toBe(0);
        expect(sawExecStdinEof).toBe(true);
        expect(lastStdinBytes).toEqual(Buffer.from([0x04, 0x41]));
        expect(process.stdin.listenerCount('data')).toBe(baseStdinListeners);

        // 2) Child gt exec -it with piped stdin on v2 (exec_stdin_eof) and v1 (0x04 fallback)
        sawExecStdinEof = false;
        const v2Child = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, [GT_BIN, '--server', serverUrl, 'exec', '-it', 'it-node', 'cat'], {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d) => (stdout += d.toString('utf-8')));
          child.stderr.on('data', (d) => (stderr += d.toString('utf-8')));
          child.on('error', reject);
          child.on('close', (c) => resolve({ code: c ?? 1, stdout, stderr }));
          child.stdin.write(Buffer.from([0x01, 0x02]));
          child.stdin.end();
        });
        expect(v2Child.code).toBe(0);
        expect(sawExecStdinEof).toBe(true);
        expect(v2Child.stdout).toContain('0102');

        behavior = 'v1-eot';
        const v1Child = await new Promise<{ code: number }>((resolve, reject) => {
          const child = spawn(process.execPath, [GT_BIN, '--server', serverUrl, 'exec', '-it', 'it-node', 'cat'], {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          child.on('error', reject);
          child.on('close', (c) => resolve({ code: c ?? 1 }));
          child.stdin.end('hi-v1');
        });
        expect(v1Child.code).toBe(0);
        expect(lastStdinBytes.includes(0x04)).toBe(true);

        // 3) unexpected-response (401) resolves with 1 cleanly
        behavior = 'upgrade-401';
        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const code401 = await runInteractiveExec({
          serverUrl,
          apiKey: '',
          hostId: 'it-node',
          fullCommand: 'bash',
          options: { tty: false },
        });
        expect(code401).toBe(1);
        expect(stderrSpy.mock.calls.map((c) => String(c[0])).join('')).toContain('401');
        stderrSpy.mockRestore();

        // 4) [Host Offline] routed to stderr, NOT stdout
        behavior = 'host-offline';
        const offlineChild = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
          const child = spawn(process.execPath, [GT_BIN, '--server', serverUrl, 'exec', '-it', 'it-node', 'bash'], {
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d) => (stdout += d.toString('utf-8')));
          child.stderr.on('data', (d) => (stderr += d.toString('utf-8')));
          child.on('error', reject);
          child.on('close', (c) => resolve({ code: c ?? 1, stdout, stderr }));
        });
        expect(offlineChild.code).toBe(1);
        expect(offlineChild.stdout).not.toContain('[Host Offline]');
        expect(offlineChild.stderr).toContain('[Host Offline]');

        // 5) SIGTERM forwards exec_kill before closing
        behavior = 'kill-on-sigterm';
        sawKillSignal = null;
        sawClientClose = false;
        const killChild = spawn(process.execPath, [GT_BIN, '--server', serverUrl, 'exec', '-it', 'it-node', 'sleep', '30'], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let killOut = '';
        killChild.stdout.on('data', (d) => (killOut += d.toString('utf-8')));
        await waitFor(() => killOut.includes('READY'));
        killChild.kill('SIGTERM');
        await new Promise<void>((resolve) => killChild.on('close', () => resolve()));
        await waitFor(() => sawClientClose);
        expect(sawKillSignal).toBe('SIGTERM');
      } finally {
        wss.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('CliTcpTunnelClient handles pre-open close/401 and ignores binary non-control frames; speedtest supports subpath+gzip/deflate and rejects incomplete streams', async () => {
      // 1. Pre-open raw TCP close does not hang CliTcpTunnelClient.connect()
      const rawTcp = net.createServer((sock) => {
        sock.end();
        sock.destroy();
      });
      await new Promise<void>((resolve) => rawTcp.listen(0, '127.0.0.1', resolve));
      const rawTcpPort = (rawTcp.address() as any).port;
      try {
        const preCloseClient = new CliTcpTunnelClient({
          serverUrl: `http://127.0.0.1:${rawTcpPort}`,
          apiKey: '',
          hostId: 'h1',
        });
        await expect(preCloseClient.connect()).rejects.toThrow();
      } finally {
        await new Promise<void>((resolve) => rawTcp.close(() => resolve()));
      }

      // 2. HTTP 401 upgrade rejection rejects CliTcpTunnelClient.connect() promptly
      const rejectServer = http.createServer();
      rejectServer.on('upgrade', (_req, socket) => {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
      });
      await new Promise<void>((resolve) => rejectServer.listen(0, '127.0.0.1', resolve));
      const rejectPort = (rejectServer.address() as any).port;
      try {
        const rejectClient = new CliTcpTunnelClient({
          serverUrl: `http://127.0.0.1:${rejectPort}`,
          apiKey: '',
          hostId: 'h1',
        });
        await expect(rejectClient.connect()).rejects.toThrow(/401/);
      } finally {
        await new Promise<void>((resolve) => rejectServer.close(() => resolve()));
      }

      // 3. CliTcpTunnelClient ignores isBinary=true frames whose leading byte is not PROXY_TCP_DATA or valid CONTROL_JSON
      const tunnelServer = http.createServer();
      const tunnelWss = new WebSocketServer({ server: tunnelServer });
      let serverTunnelWs: any = null;
      tunnelWss.on('connection', (ws) => {
        serverTunnelWs = ws;
        ws.on('message', (data: Buffer, isBinary: boolean) => {
          if (!isBinary) {
            const s = data.toString('utf-8');
            if (s.startsWith('JSON:')) {
              const ctrl = JSON.parse(s.slice(5));
              if (ctrl.type === 'proxy_tcp_connect') {
                ws.send(`JSON:${JSON.stringify({ type: 'proxy_tcp_connected', streamId: ctrl.streamId })}`);
                // Send spoofed JSON: close as a BINARY frame (first byte 'J', not PROXY_TCP_DATA/CONTROL_JSON)
                ws.send(Buffer.from(`JSON:${JSON.stringify({ type: 'proxy_tcp_close', streamId: ctrl.streamId, error: 'spoofed' })}`), { binary: true });
                // Send malformed CONTROL_JSON binary frame
                ws.send(Buffer.from([BIN_MSG_TYPE.CONTROL_JSON, 0x00, 0x7b, 0x21]), { binary: true });
              }
            }
          }
        });
      });
      await new Promise<void>((resolve) => tunnelServer.listen(0, '127.0.0.1', resolve));
      const tunnelPort = (tunnelServer.address() as any).port;
      try {
        const client = new CliTcpTunnelClient({
          serverUrl: `http://127.0.0.1:${tunnelPort}`,
          apiKey: '',
          hostId: 'h1',
        });
        await client.connect();
        const onConnected = jest.fn();
        const onClose = jest.fn();
        const stream = client.openStream('127.0.0.1', 80, jest.fn(), onClose, onConnected);
        await waitFor(() => onConnected.mock.calls.length === 1);
        await new Promise((r) => setTimeout(r, 80));
        expect(onClose).not.toHaveBeenCalled();
        stream.close();
        client.close();
      } finally {
        try { serverTunnelWs?.close(); } catch {}
        tunnelWss.close();
        await new Promise<void>((resolve) => tunnelServer.close(() => resolve()));
      }

      // 4. runSpeedtestBenchmark subpath + gzip/deflate + incomplete download/upload rejection
      let dlMode: 'ok' | 'truncated' = 'ok';
      let ulMode: 'ok' | 'premature-close' = 'ok';
      const seenPaths: string[] = [];

      const stServer = http.createServer((req, res) => {
        const reqUrl = req.url || '';
        seenPaths.push(reqUrl);

        if (reqUrl === '/sub/api/proxy/h1/speedtest/ping') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
          res.end(zlib.gzipSync(Buffer.from(JSON.stringify({ success: true, hubAgentRttMs: 2.5 }))));
          return;
        }
        if (reqUrl.startsWith('/sub/api/proxy/h1/speedtest/download')) {
          if (dlMode === 'truncated') {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '65536' });
            res.write(Buffer.alloc(1024, 0xaa));
            setTimeout(() => { res.socket?.destroy(); }, 20);
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '65536' });
          res.end(Buffer.alloc(65536, 0x55));
          return;
        }
        if (reqUrl === '/sub/api/proxy/h1/speedtest/upload') {
          if (ulMode === 'premature-close') {
            res.socket?.destroy();
            return;
          }
          req.on('data', () => {});
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ receivedBytes: 65536, agentDurationMs: 5 }));
          });
          return;
        }
        if (reqUrl === '/sub/api/proxy/h1/speedtest/probe') {
          req.on('data', () => {});
          req.on('end', () => {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate' });
            res.end(zlib.deflateRawSync(Buffer.from(JSON.stringify({
              success: true,
              results: [{ url: 'https://example.com', ok: true, statusCode: 200, latencyMs: 12 }],
            }))));
          });
          return;
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => stServer.listen(0, '127.0.0.1', resolve));
      const stPort = (stServer.address() as any).port;
      const stBase = `http://127.0.0.1:${stPort}/sub`;

      try {
        const report = await runSpeedtestBenchmark({
          serverUrl: stBase,
          apiKey: 'k',
          hostId: 'h1',
          sizeBytes: 65536,
          pings: 2,
        });
        expect(report.download.bytes).toBe(65536);
        expect(report.upload.bytes).toBe(65536);
        expect(report.probes[0]?.ok).toBe(true);
        expect(seenPaths.every((p) => p.startsWith('/sub/api/proxy/h1/speedtest/'))).toBe(true);

        dlMode = 'truncated';
        await expect(
          runSpeedtestBenchmark({ serverUrl: stBase, apiKey: 'k', hostId: 'h1', sizeBytes: 65536, pings: 1 })
        ).rejects.toThrow(/prematurely|aborted|closed|socket/i);

        dlMode = 'ok';
        ulMode = 'premature-close';
        await expect(
          runSpeedtestBenchmark({ serverUrl: stBase, apiKey: 'k', hostId: 'h1', sizeBytes: 65536, pings: 1 })
        ).rejects.toThrow();
      } finally {
        await new Promise<void>((resolve) => stServer.close(() => resolve()));
      }
    });

    it('makeRequest and cp.ts preserve subpaths, reject truncated responses, and guard readStream callbacks after early 401', async () => {
      const seenPaths: string[] = [];
      let retry500Count = 0;

      const server = http.createServer((req, res) => {
        const u = req.url || '';
        seenPaths.push(u);

        if (u === '/gw/api/truncated') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '200' });
          res.write('{"partial":');
          setTimeout(() => { res.socket?.destroy(); }, 20);
          return;
        }
        if (u === '/gw/api/ok') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (u.startsWith('/gw/api/terminal/files/upload')) {
          // Immediately reject with 401 while client is still streaming a 256KB file
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized upload' }));
          return;
        }
        if (u.startsWith('/gw/api/terminal/files/download')) {
          if (u.includes('err403-drop')) {
            res.writeHead(403, { 'Content-Type': 'application/json', 'Content-Length': '120' });
            res.write('{"error":"forb');
            setTimeout(() => { res.socket?.destroy(); }, 20);
            return;
          }
          if (u.includes('err500-drop')) {
            if (retry500Count === 0) {
              retry500Count++;
              res.writeHead(500, { 'Content-Type': 'application/json', 'Content-Length': '120' });
              res.write('{"error":"tmp');
              setTimeout(() => { res.socket?.destroy(); }, 20);
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '7' });
            res.end('ok-body');
            return;
          }
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;
      const subUrl = `http://127.0.0.1:${port}/gw`;
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-cp-subpath-'));

      try {
        const okRes = await makeRequest({ serverUrl: subUrl, endpoint: '/api/ok' });
        expect(okRes.data).toEqual({ ok: true });

        await expect(makeRequest({ serverUrl: subUrl, endpoint: '/api/truncated' })).rejects.toThrow(/prematurely|aborted/i);

        // Large file (> 64KB highWaterMark) rejected early with 401 must settle cleanly without stream write-after-destroy crash
        const bigLocalFile = path.join(tmpDir, 'big.bin');
        fs.writeFileSync(bigLocalFile, Buffer.alloc(256 * 1024, 0x7a));
        await expect(
          uploadLocalFile({
            serverUrl: subUrl,
            apiKey: 'bad',
            hostId: 'h1',
            localPath: bigLocalFile,
            remotePath: '/tmp/big.bin',
          })
        ).rejects.toThrow(/Upload failed/i);

        // Prematurely closed 403 fails immediately (no hang)
        await expect(
          downloadRemoteFile({
            serverUrl: subUrl,
            apiKey: 'k',
            hostId: 'h1',
            remotePath: '/remote/err403-drop',
            localPath: path.join(tmpDir, '403.bin'),
          })
        ).rejects.toThrow(/Download failed: HTTP 403/i);

        // Prematurely closed 500 retries and succeeds
        const dest500 = path.join(tmpDir, '500.bin');
        const dlCode = await downloadRemoteFile({
          serverUrl: subUrl,
          apiKey: 'k',
          hostId: 'h1',
          remotePath: '/remote/err500-drop',
          localPath: dest500,
        });
        expect(dlCode).toBe(0);
        expect(fs.readFileSync(dest500, 'utf-8')).toBe('ok-body');
        expect(seenPaths.every((p) => p.startsWith('/gw/api/'))).toBe(true);
      } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('enforces cross-host isolation on TerminalProxyBridge, TerminalExecBridge, and drops invalid binary frames on /api/terminal/ws', async () => {
      config.adminSecretKey = '';
      const server = http.createServer();
      const wss = setupTerminalWebSocket(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;

      const agentA = new EventEmitter() as any;
      agentA.readyState = 1;
      agentA._binaryControl = true;
      agentA._framedTerminal = true;
      agentA.send = jest.fn();

      const agentB = new EventEmitter() as any;
      agentB.readyState = 1;
      agentB._binaryControl = true;
      agentB._framedTerminal = true;
      agentB.send = jest.fn();

      terminalHostManager.registerAgent({ hostId: 'iso-host-a', name: 'iso-host-a', agentWs: agentA });
      terminalHostManager.registerAgent({ hostId: 'iso-host-b', name: 'iso-host-b', agentWs: agentB });

      const proxyCliA = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/proxy-ws?hostId=iso-host-a&binaryControl=1`);
      const proxyCliB = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/proxy-ws?hostId=iso-host-b&binaryControl=1`);
      const execCliA = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/exec-ws?hostId=iso-host-a`);
      const termCliBin = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws?hostId=iso-host-a&binaryControl=1`);
      const termCliLegacy = new WebSocket(`ws://127.0.0.1:${port}/api/terminal/ws?hostId=iso-host-a`);

      const proxyCliAMsgs: any[] = [];
      const proxyCliAData: Buffer[] = [];
      proxyCliA.on('message', (d: any, isBinary: boolean) => {
        if (isBinary) {
          const buf = Buffer.from(d);
          if (buf[0] === BIN_MSG_TYPE.PROXY_TCP_DATA) {
            proxyCliAData.push(decodeBinaryPacket(buf)!.payload);
          } else {
            const c = decodeControlJsonPacket(buf);
            if (c) proxyCliAMsgs.push(c);
          }
        }
      });

      const proxyCliBMsgs: any[] = [];
      proxyCliB.on('message', (d: any, isBinary: boolean) => {
        if (isBinary) {
          const c = decodeControlJsonPacket(Buffer.from(d));
          if (c) proxyCliBMsgs.push(c);
        }
      });

      const execCliAMsgs: any[] = [];
      const execCliAData: Buffer[] = [];
      execCliA.on('message', (d: any, isBinary: boolean) => {
        if (isBinary) execCliAData.push(Buffer.from(d));
        else execCliAMsgs.push(JSON.parse(d.toString('utf-8')));
      });

      const termBinReplies: any[] = [];
      const termBinTextOutputs: string[] = [];
      termCliBin.on('message', (d: any, isBinary: boolean) => {
        if (isBinary) {
          const decoded = decodeBinaryControlFrame(d);
          if (decoded) termBinReplies.push(decoded);
        } else {
          const text = typeof d === 'string' ? d : d.toString('utf-8');
          termBinTextOutputs.push(text);
        }
      });

      try {
        await Promise.all([
          new Promise<void>((r, rej) => { proxyCliA.once('open', () => r()); proxyCliA.once('error', rej); }),
          new Promise<void>((r, rej) => { proxyCliB.once('open', () => r()); proxyCliB.once('error', rej); }),
          new Promise<void>((r, rej) => { execCliA.once('open', () => r()); execCliA.once('error', rej); }),
          new Promise<void>((r, rej) => { termCliBin.once('open', () => r()); termCliBin.once('error', rej); }),
          new Promise<void>((r, rej) => { termCliLegacy.once('open', () => r()); termCliLegacy.once('error', rej); }),
        ]);

        // 1) Both hosts can open identical streamId without global collision
        proxyCliA.send(encodeControlJsonPacket({ type: 'proxy_tcp_connect', streamId: 'shared-s1', host: '127.0.0.1', port: 9000 }, 'iso-host-a'), { binary: true });
        proxyCliB.send(encodeControlJsonPacket({ type: 'proxy_tcp_connect', streamId: 'shared-s1', host: '127.0.0.1', port: 9001 }, 'iso-host-b'), { binary: true });
        await waitFor(() =>
          agentA.send.mock.calls.some((c: any[]) => Buffer.isBuffer(c[0]) && decodeControlJsonPacket(c[0])?.streamId === 'shared-s1') &&
          agentB.send.mock.calls.some((c: any[]) => Buffer.isBuffer(c[0]) && decodeControlJsonPacket(c[0])?.streamId === 'shared-s1')
        );
        expect(proxyCliBMsgs.some((m) => m.code === 'EEXIST')).toBe(false);

        // 2) Cross-host proxy spoofing from iso-host-b must NOT inject into or close iso-host-a's stream or RPCs
        const pingPromiseA = terminalProxyBridge.pingAgent('iso-host-a', 5000);
        await waitFor(() =>
          agentA.send.mock.calls.some((c: any[]) => Buffer.isBuffer(c[0]) && decodeControlJsonPacket(c[0])?.type === 'proxy_net_ping')
        );
        const pingReqIdA = agentA.send.mock.calls
          .filter((c: any[]) => Buffer.isBuffer(c[0]))
          .map((c: any[]) => decodeControlJsonPacket(c[0]))
          .find((ctrl: any) => ctrl?.type === 'proxy_net_ping').reqId;

        terminalProxyBridge.handleAgentControlMessage('iso-host-b', { type: 'proxy_net_ping_res', reqId: pingReqIdA, agentTimestamp: 1 });
        terminalProxyBridge.handleAgentBinaryFrame('iso-host-b', { msgType: BIN_MSG_TYPE.PROXY_TCP_DATA, id: 'shared-s1', payload: Buffer.from('from-b') });
        terminalProxyBridge.handleAgentControlMessage('iso-host-b', { type: 'proxy_tcp_close', streamId: 'shared-s1', error: 'hijack' });

        await new Promise((r) => setTimeout(r, 40));
        expect(proxyCliAData.length).toBe(0);
        expect(proxyCliAMsgs.some((m) => m.error === 'hijack')).toBe(false);

        // Real host A ping response still resolves pingPromiseA cleanly
        terminalProxyBridge.handleAgentControlMessage('iso-host-a', { type: 'proxy_net_ping_res', reqId: pingReqIdA, agentTimestamp: 42 });
        const pingResA = await pingPromiseA;
        expect(pingResA.success).toBe(true);
        expect(pingResA.agentTimestamp).toBe(42);

        // Also test HTTP proxy cross-host isolation on TerminalProxyBridge
        const mockHttpReq = new EventEmitter() as any;
        mockHttpReq.headers = {};
        mockHttpReq.method = 'GET';
        const resWrites: Buffer[] = [];
        let resEnded = false;
        const mockHttpRes = new EventEmitter() as any;
        mockHttpRes.headersSent = false;
        mockHttpRes.writableEnded = false;
        mockHttpRes.writableLength = 0;
        mockHttpRes.statusCode = 200;
        mockHttpRes.setHeader = jest.fn();
        mockHttpRes.getHeader = jest.fn();
        mockHttpRes.flushHeaders = jest.fn(() => { mockHttpRes.headersSent = true; });
        mockHttpRes.write = jest.fn((chunk: Buffer) => { resWrites.push(Buffer.from(chunk)); return true; });
        mockHttpRes.end = jest.fn(() => { resEnded = true; mockHttpRes.writableEnded = true; });
        mockHttpRes.status = jest.fn(() => mockHttpRes);
        mockHttpRes.json = jest.fn();

        terminalProxyBridge.handleHttpProxyRequest(mockHttpReq, mockHttpRes, {
          hostId: 'iso-host-a',
          targetUrl: 'http://127.0.0.1:8080/test',
        });
        const httpReqIdA = agentA.send.mock.calls
          .filter((c: any[]) => Buffer.isBuffer(c[0]))
          .map((c: any[]) => decodeControlJsonPacket(c[0]))
          .find((ctrl: any) => ctrl?.type === 'proxy_http_start').reqId;

        // Spoofed headers/body/end from iso-host-b must be ignored
        terminalProxyBridge.handleAgentControlMessage('iso-host-b', { type: 'proxy_http_headers', reqId: httpReqIdA, statusCode: 500 });
        terminalProxyBridge.handleAgentBinaryFrame('iso-host-b', { msgType: BIN_MSG_TYPE.PROXY_HTTP_RES_BODY, id: httpReqIdA, payload: Buffer.from('evil') });
        terminalProxyBridge.handleAgentControlMessage('iso-host-b', { type: 'proxy_http_end', reqId: httpReqIdA });
        expect(mockHttpRes.headersSent).toBe(false);
        expect(resWrites.length).toBe(0);
        expect(resEnded).toBe(false);

        // Genuine iso-host-a completion succeeds
        terminalProxyBridge.handleAgentControlMessage('iso-host-a', { type: 'proxy_http_headers', reqId: httpReqIdA, statusCode: 200 });
        terminalProxyBridge.handleAgentBinaryFrame('iso-host-a', { msgType: BIN_MSG_TYPE.PROXY_HTTP_RES_BODY, id: httpReqIdA, payload: Buffer.from('legit') });
        terminalProxyBridge.handleAgentControlMessage('iso-host-a', { type: 'proxy_http_end', reqId: httpReqIdA });
        expect(mockHttpRes.statusCode).toBe(200);
        expect(Buffer.concat(resWrites).toString('utf-8')).toBe('legit');
        expect(resEnded).toBe(true);

        // 3) Cross-host exec-ws isolation: iso-host-b cannot inject STREAM_OUTPUT or cmd_stream_exit for iso-host-a's task
        execCliA.send(JSON.stringify({ type: 'exec_start', command: 'cat', tty: false }));
        await waitFor(() => execCliAMsgs.some((m) => m.type === 'exec_started'));
        const taskIdA = execCliAMsgs.find((m) => m.type === 'exec_started').taskId;

        terminalExecBridge.handleAgentStreamMessage('iso-host-b', encodeBinaryPacket(BIN_MSG_TYPE.STREAM_OUTPUT, taskIdA, Buffer.from('forged-bin')));
        terminalExecBridge.handleAgentStreamMessage('iso-host-b', { type: 'cmd_stream_data', taskId: taskIdA, data: Buffer.from('forged-b64').toString('base64') });
        terminalExecBridge.handleAgentStreamMessage('iso-host-b', { type: 'cmd_stream_exit', taskId: taskIdA, exitCode: 99 });
        await new Promise((r) => setTimeout(r, 40));
        expect(execCliAData.length).toBe(0);
        expect(execCliAMsgs.some((m) => m.type === 'exec_exit')).toBe(false);

        // Real host A exit succeeds
        terminalExecBridge.handleAgentStreamMessage('iso-host-a', { type: 'cmd_stream_exit', taskId: taskIdA, exitCode: 0 });
        await waitFor(() => execCliAMsgs.some((m) => m.type === 'exec_exit'));

        // 4) /api/terminal/ws drops malformed CONTROL_JSON and unrecognized binary frames under _binaryControl=1
        const agentMainCountBefore = agentA.send.mock.calls.length;
        termCliBin.send(Buffer.from([BIN_MSG_TYPE.CONTROL_JSON, 0x00, 0x7b, 0x21]), { binary: true });
        termCliBin.send(encodeBinaryPacket(BIN_MSG_TYPE.CONTROL_JSON, 'iso-host-a', '{"type":"unknown_evil"}'), { binary: true });
        termCliBin.send(Buffer.from([0x09, 0x01, 0x41, 0x42]), { binary: true });
        termCliLegacy.send(Buffer.from([BIN_MSG_TYPE.CONTROL_JSON, 0x00, 0x7b, 0x21]), { binary: true });
        await new Promise((r) => setTimeout(r, 50));
        expect(agentA.send.mock.calls.length).toBe(agentMainCountBefore);

        // Valid text input & binary CONTROL_JSON ping work, and frontend protocol helpers decode Hub CONTROL_JSON + pass through non-control JSON:
        termCliBin.send('OK_INPUT\r');
        termCliBin.send(encodeControlJsonPacket({ type: 'ping' }, 'iso-host-a'), { binary: true });
        terminalHostManager.handleAgentData('iso-host-a', 'JSON:{"foo":"bar"}\r\n');
        await waitFor(() =>
          agentA.send.mock.calls.some((c: any[]) => Buffer.isBuffer(c[0]) && decodeBinaryPacket(c[0])?.payload.toString('utf-8') === 'OK_INPUT\r') &&
          termBinReplies.some((m) => m.type === 'pong') &&
          termBinTextOutputs.some((t) => t.includes('JSON:{"foo":"bar"}'))
        , 4000, 15, 'termCliBin roundtrip');

        // Frontend terminalProtocol helper verification
        const sampleCtrl = encodeBinaryControlFrame({ type: 'pane_exit', paneId: 'split', exitCode: 0 }, 'iso-host-a');
        expect(isBinaryControlPacket(sampleCtrl)).toBe(true);
        expect(decodeBinaryControlFrame(sampleCtrl)).toEqual({ type: 'pane_exit', paneId: 'split', exitCode: 0 });
        expect(decodeBinaryControlFrame(Buffer.from([BIN_MSG_TYPE.CONTROL_JSON, 0x00, 0x7b, 0x21]))).toBeNull();
        expect(parseTerminalTextControlFrame('JSON:{"type":"pong"}')).toEqual({ type: 'pong' });
        expect(parseTerminalTextControlFrame('JSON:{"foo":"bar"}')).toBeNull();
        expect(parseTerminalTextControlFrame('JSON:{"type":"custom_user"}')).toBeNull();

        // Check WebTerminalView & useTerminalWebSocket integrate binaryControl=1 cleanly
        const webTermSrc = fs.readFileSync(path.resolve(__dirname, '../frontend/src/components/WebTerminalView.tsx'), 'utf-8');
        const hookSrc = fs.readFileSync(path.resolve(__dirname, '../frontend/src/components/terminal/hooks/useTerminalWebSocket.ts'), 'utf-8');
        expect(webTermSrc).toContain('binaryControl=1');
        expect(webTermSrc).toContain('decodeBinaryControlFrame');
        expect(webTermSrc).toContain('binaryControlConfirmedRef');
        expect(webTermSrc).toContain('toUint8Array');
        expect(hookSrc).toContain('binaryControl=1');
        expect(hookSrc).toContain('decodeBinaryControlFrame');
        expect(hookSrc).toContain('binaryControlConfirmedRef');
        expect(hookSrc).toContain('toUint8Array');
      } finally {
        proxyCliA.close();
        proxyCliB.close();
        execCliA.close();
        termCliBin.close();
        termCliLegacy.close();
        terminalHostManager.unregisterAgent('iso-host-a', agentA);
        terminalHostManager.unregisterAgent('iso-host-b', agentB);
        try {
          (wss as any).closeAllClients?.(1001, 'Done');
          wss.close();
        } catch {}
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('rejects statusless 1005 WS closes, supports exec -i on TTY, handles speedtest timeouts/early-upload-200, and tests PTY SIGINT', async () => {
      // 1. exec.ts & interactiveExec.ts reject statusless 1005 close instead of falsely exiting 0
      let close1005Phase: 'pre-start' | 'post-start' | 'tty-interactive' = 'pre-start';
      let receivedTtyStdin = Buffer.alloc(0);
      let sawTtyEof = false;
      const wsServer1005 = http.createServer();
      const wss1005 = new WebSocketServer({ server: wsServer1005 });

      wss1005.on('connection', (ws) => {
        const chunks: Buffer[] = [];
        ws.on('message', (data: Buffer, isBinary: boolean) => {
          if (isBinary) {
            chunks.push(Buffer.from(data));
            return;
          }
          const msg = JSON.parse(data.toString('utf-8'));
          if (msg.type === 'exec_start') {
            if (close1005Phase === 'pre-start') {
              ws.close(); // emits 1005 No Status Received before exec_started
              return;
            }
            ws.send(JSON.stringify({
              type: 'exec_started',
              taskId: 't-1005',
              protocolVersion: 2,
              capabilities: { stdinEof: true, binaryStdin: true },
            }));
            if (close1005Phase === 'post-start') {
              setTimeout(() => ws.close(), 20); // emits 1005 without exec_exit
            }
          } else if (msg.type === 'exec_stdin_eof' && close1005Phase === 'tty-interactive') {
            sawTtyEof = true;
            receivedTtyStdin = Buffer.concat(chunks);
            ws.send(JSON.stringify({ type: 'exec_exit', exitCode: 0 }));
          }
        });
      });

      await new Promise<void>((resolve) => wsServer1005.listen(0, '127.0.0.1', resolve));
      const wsPort = (wsServer1005.address() as any).port;
      const wsUrl = `http://127.0.0.1:${wsPort}`;

      try {
        close1005Phase = 'pre-start';
        await expect(
          runStreamExec({
            serverUrl: wsUrl,
            apiKey: '',
            hostId: 'n1',
            fullCommand: 'echo hi',
            options: { detach: false, timeoutMs: 5000, verbose: false, pollInterval: 50, env: {}, interactive: false, tty: false, mode: 'stream' },
            startTime: Date.now(),
          })
        ).rejects.toMatchObject({ allowHttpFallback: true });

        close1005Phase = 'post-start';
        await expect(
          runStreamExec({
            serverUrl: wsUrl,
            apiKey: '',
            hostId: 'n1',
            fullCommand: 'echo hi',
            options: { detach: false, timeoutMs: 5000, verbose: false, pollInterval: 50, env: {}, interactive: false, tty: false, mode: 'stream' },
            startTime: Date.now(),
          })
        ).rejects.toMatchObject({ allowHttpFallback: false });

        const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        const interactive1005 = await runInteractiveExec({
          serverUrl: wsUrl,
          apiKey: '',
          hostId: 'n1',
          fullCommand: 'bash',
          options: { tty: false },
        });
        expect(interactive1005).toBe(1);
        errSpy.mockRestore();

        // 2. runStreamExec with options.interactive=true and process.stdin.isTTY=true attaches stdin
        close1005Phase = 'tty-interactive';
        const origIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
        const origReadableEnded = Object.getOwnPropertyDescriptor(process.stdin, 'readableEnded');
        Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
        Object.defineProperty(process.stdin, 'readableEnded', { value: false, configurable: true });
        try {
          const baseDataListeners = process.stdin.listenerCount('data');
          const ttyStreamPromise = runStreamExec({
            serverUrl: wsUrl,
            apiKey: '',
            hostId: 'n1',
            fullCommand: 'cat',
            options: { detach: false, timeoutMs: 5000, verbose: false, pollInterval: 50, env: {}, interactive: true, tty: false, mode: 'stream' },
            startTime: Date.now(),
          });
          await waitFor(() => process.stdin.listenerCount('data') === baseDataListeners + 1);
          process.stdin.emit('data', Buffer.from('tty-interactive-bytes'));
          process.stdin.emit('end');
          const ttyCode = await ttyStreamPromise;
          expect(ttyCode).toBe(0);
          expect(sawTtyEof).toBe(true);
          expect(receivedTtyStdin.toString('utf-8')).toBe('tty-interactive-bytes');
        } finally {
          if (origIsTTY) Object.defineProperty(process.stdin, 'isTTY', origIsTTY);
          else delete (process.stdin as any).isTTY;
          if (origReadableEnded) Object.defineProperty(process.stdin, 'readableEnded', origReadableEnded);
          else delete (process.stdin as any).readableEnded;
        }
      } finally {
        wss1005.close();
        await new Promise<void>((resolve) => wsServer1005.close(() => resolve()));
      }

      // 3. runSpeedtestBenchmark timeouts (no hang) + early upload 200 rejection
      let stBehavior: 'hang-ping' | 'hang-download' | 'early-upload-200' = 'hang-ping';
      const stServer = http.createServer((req, res) => {
        const u = req.url || '';
        if (u.endsWith('/speedtest/ping')) {
          if (stBehavior === 'hang-ping') return; // intentionally hang
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, hubAgentRttMs: 1 }));
          return;
        }
        if (u.includes('/speedtest/download')) {
          if (stBehavior === 'hang-download') {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '65536' });
            res.write(Buffer.alloc(1024));
            return; // hang mid-stream
          }
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '65536' });
          res.end(Buffer.alloc(65536));
          return;
        }
        if (u.endsWith('/speedtest/upload')) {
          if (stBehavior === 'early-upload-200') {
            // Drain partial or reply immediately before client finishes large upload
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ receivedBytes: 0 }));
            return;
          }
        }
        res.writeHead(404);
        res.end();
      });

      await new Promise<void>((resolve) => stServer.listen(0, '127.0.0.1', resolve));
      const stPort = (stServer.address() as any).port;
      const stUrl = `http://127.0.0.1:${stPort}`;
      try {
        stBehavior = 'hang-ping';
        await expect(
          runSpeedtestBenchmark({ serverUrl: stUrl, apiKey: '', hostId: 'h1', sizeBytes: 65536, pings: 1, requestTimeoutMs: 60 })
        ).rejects.toThrow(/timed out/i);

        stBehavior = 'hang-download';
        await expect(
          runSpeedtestBenchmark({ serverUrl: stUrl, apiKey: '', hostId: 'h1', sizeBytes: 65536, pings: 1, requestTimeoutMs: 80 })
        ).rejects.toThrow(/timed out/i);

        stBehavior = 'early-upload-200';
        await expect(
          runSpeedtestBenchmark({ serverUrl: stUrl, apiKey: '', hostId: 'h1', sizeBytes: 4 * 1024 * 1024, pings: 1, requestTimeoutMs: 2000 })
        ).rejects.toThrow(/aborted early|closed|ECONNRESET|EPIPE/i);
      } finally {
        if (typeof (stServer as any).closeAllConnections === 'function') {
          (stServer as any).closeAllConnections();
        }
        await new Promise<void>((resolve) => stServer.close(() => resolve()));
      }

      // 4. Live PTY (node-pty) test for gt exec -it SIGINT / Ctrl+C forwarding exec_kill
      const { tryRequirePty } = require('../src/agent/pty/drivers');
      const nodePty = tryRequirePty();
      if (nodePty) {
        let ptyKillSignal: string | null = null;
        const ptySrv = http.createServer((req, res) => {
          if (req.url?.startsWith('/api/terminal/hosts')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hosts: [{ id: 'pty-node', name: 'pty-node', status: 'online' }] }));
            return;
          }
          res.writeHead(404);
          res.end();
        });
        const ptyWss = new WebSocketServer({ server: ptySrv });
        ptyWss.on('connection', (ws) => {
          ws.on('message', (data: Buffer, isBinary: boolean) => {
            if (isBinary) {
              if (data.includes(0x03)) {
                // In raw mode, Ctrl+C arrives as 0x03 or SIGINT triggers exec_kill; support both observations
                ptyKillSignal = ptyKillSignal || 'CTRL_C_RAW';
              }
              return;
            }
            const msg = JSON.parse(data.toString('utf-8'));
            if (msg.type === 'exec_start') {
              ws.send(JSON.stringify({ type: 'exec_started', taskId: 'pty-t1', protocolVersion: 2, capabilities: { stdinEof: true } }));
              ws.send(Buffer.from('PTY_READY\n'), { binary: true });
            } else if (msg.type === 'exec_kill') {
              ptyKillSignal = msg.signal || 'SIGTERM';
            }
          });
        });

        await new Promise<void>((resolve) => ptySrv.listen(0, '127.0.0.1', resolve));
        const ptyPort = (ptySrv.address() as any).port;
        try {
          const ptyTerm = nodePty.spawn(
            process.execPath,
            [GT_BIN, '--server', `http://127.0.0.1:${ptyPort}`, 'exec', '-it', 'pty-node', 'sleep', '30'],
            { cols: 80, rows: 24, cwd: process.cwd(), env: process.env as Record<string, string> }
          );
          let ptyOut = '';
          ptyTerm.onData((d: string) => { ptyOut += d; });
          await waitFor(() => ptyOut.includes('PTY_READY'), 5000);
          // Give rawMode a brief tick to settle, then deliver real SIGINT to the child process
          await new Promise((r) => setTimeout(r, 50));
          try { process.kill(ptyTerm.pid, 'SIGINT'); } catch {}
          const ptyExit = await new Promise<number>((resolve) => {
            ptyTerm.onExit(({ exitCode }: { exitCode: number }) => resolve(exitCode));
          });
          await waitFor(() => ptyKillSignal !== null, 3000);
          expect(ptyKillSignal).toBe('SIGINT');
          expect(ptyExit).toBe(130);
        } finally {
          ptyWss.close();
          await new Promise<void>((resolve) => ptySrv.close(() => resolve()));
        }
      }
    }, 15000);

    it('mounts useTerminalWebSocket against real Hub /api/terminal/ws?binaryControl=1 and verifies ArrayBuffer CONTROL_JSON & JSON: passthrough', async () => {
      config.adminSecretKey = '';
      const server = http.createServer();
      const wss = setupTerminalWebSocket(server);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as any).port;

      const agentWs = new EventEmitter() as any;
      agentWs.readyState = 1;
      agentWs._binaryControl = true;
      agentWs._framedTerminal = true;
      agentWs.send = jest.fn();
      terminalHostManager.registerAgent({ hostId: 'hook-rt-host', name: 'hook-rt-host', agentWs });

      // Bridge browser WebSocket global to real Node ws so useTerminalWebSocket executes unmodified
      const origWebSocket = (globalThis as any).WebSocket;
      const origWindow = (globalThis as any).window;
      const spawnedSockets: WebSocket[] = [];

      class BrowserWsBridge {
        public static OPEN = 1;
        public OPEN = 1;
        public binaryType = 'arraybuffer';
        public onopen: ((ev?: any) => void) | null = null;
        public onmessage: ((ev: { data: any }) => void) | null = null;
        public onclose: ((ev?: any) => void) | null = null;
        public onerror: ((ev?: any) => void) | null = null;
        private inner: WebSocket;

        constructor(url: string) {
          this.inner = new WebSocket(url);
          spawnedSockets.push(this.inner);
          this.inner.on('open', () => this.onopen?.({}));
          this.inner.on('message', (data: Buffer, isBinary: boolean) => {
            if (isBinary) {
              const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
              this.onmessage?.({ data: ab });
            } else {
              this.onmessage?.({ data: data.toString('utf-8') });
            }
          });
          this.inner.on('close', (code: number, reason: Buffer) => this.onclose?.({ code, reason: reason?.toString() }));
          this.inner.on('error', (err: Error) => this.onerror?.(err));
        }

        get readyState() {
          return this.inner.readyState;
        }
        send(payload: any) {
          this.inner.send(payload);
        }
        close(code?: number, reason?: string) {
          if (code === 1012) {
            // Simulate browser WebSocket InvalidAccessError for non-1000/3000-4999 close code
            throw new Error('InvalidAccessError');
          }
          if (code !== undefined) this.inner.close(code, reason);
          else this.inner.close();
        }
      }

      const termWrites: string[] = [];
      let clearCount = 0;
      let resetCount = 0;
      const onPaneExit = jest.fn();

      const mockTerm = {
        cols: 80,
        rows: 24,
        buffer: { active: { type: 'normal', viewportY: 0, baseY: 0 } },
        clear: jest.fn(() => { clearCount++; }),
        reset: jest.fn(() => { resetCount++; }),
        refresh: jest.fn(),
        focus: jest.fn(),
        scrollToBottom: jest.fn(),
        writeln: jest.fn((line: string) => termWrites.push(line)),
        write: jest.fn((chunk: string | Uint8Array, cb?: () => void) => {
          const txt = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
          termWrites.push(txt);
          cb?.();
        }),
      };

      const mockFitAddon = { fit: jest.fn(), proposeDimensions: () => ({ cols: 80, rows: 24 }) };
      let hookReturn: any = null;

      try {
        (globalThis as any).window = {
          location: { protocol: 'http:', host: `127.0.0.1:${port}` },
          innerWidth: 1280,
          innerHeight: 800,
        };
        (globalThis as any).WebSocket = BrowserWsBridge;

        jest.isolateModules(() => {
          const stateValues: any[] = [];
          let stateIdx = 0;
          const refs: any[] = [];
          let refIdx = 0;
          jest.doMock('react', () => ({
            useState: (init: any) => {
              const i = stateIdx++;
              if (!(i in stateValues)) stateValues[i] = typeof init === 'function' ? init() : init;
              return [stateValues[i], (v: any) => { stateValues[i] = typeof v === 'function' ? v(stateValues[i]) : v; }];
            },
            useRef: (init: any) => {
              const i = refIdx++;
              if (!(i in refs)) refs[i] = { current: init };
              return refs[i];
            },
            useCallback: (fn: any) => fn,
            useEffect: (fn: any) => { fn(); },
          }), { virtual: true });

          const { useTerminalWebSocket } = require('../frontend/src/components/terminal/hooks/useTerminalWebSocket');
          hookReturn = useTerminalWebSocket({
            adminKey: '',
            activeHostId: 'hook-rt-host',
            paneId: 'main',
            xtermRef: { current: mockTerm },
            fitAddonRef: { current: mockFitAddon },
            isMountedRef: { current: true },
            isAtBottomRef: { current: true },
            isRefittingRef: { current: false },
            isMobileRef: { current: false },
            safeFit: () => true,
            onPaneExit,
          });
          hookReturn.initWebSocket();
        });

        await waitFor(() => hookReturn?.wsRef?.current?.readyState === 1, 4000);
        // Wait for initial ping -> binary CONTROL_JSON pong roundtrip so binaryControlConfirmedRef becomes true
        await new Promise((r) => setTimeout(r, 80));

        const clearBeforePassthrough = clearCount;
        const resetBeforePassthrough = resetCount;

        // 1) Literal terminal stdout containing JSON:{"type":"reset"} and JSON:{"foo":"bar"} MUST pass through to xterm untouched!
        terminalHostManager.handleAgentData('hook-rt-host', Buffer.from('JSON:{"type":"reset"}\r\nJSON:{"foo":"bar"}\r\n'));
        await waitFor(() => termWrites.some((w) => w.includes('JSON:{"type":"reset"}') && w.includes('JSON:{"foo":"bar"}')));
        expect(clearCount).toBe(clearBeforePassthrough);
        expect(resetCount).toBe(resetBeforePassthrough);

        // 2) Real Hub binary CONTROL_JSON reset clears & resets xterm
        const session = terminalHostManager.getSession('hook-rt-host', 'main')!;
        session.reset(true, false);
        await waitFor(() => resetCount > resetBeforePassthrough);
        expect(clearCount).toBeGreaterThan(clearBeforePassthrough);

        // 3) Real Hub binary CONTROL_JSON pane_exit triggers onPaneExit callback
        session.notifyPaneExited(0);
        await waitFor(() => onPaneExit.mock.calls.length === 1);

        // 4) Direct Uint8Array binary CONTROL_JSON reset and malformed 0x08 drop
        const writesBeforeMalformed = termWrites.length;
        hookReturn.wsRef.current.onmessage({ data: new Uint8Array([BIN_MSG_TYPE.CONTROL_JSON, 0x00, 0x7b, 0x21]) });
        expect(termWrites.length).toBe(writesBeforeMalformed);

        const resetsBeforeUint8 = resetCount;
        hookReturn.wsRef.current.onmessage({ data: encodeBinaryControlFrame({ type: 'reset' }, 'hook-rt-host') });
        expect(resetCount).toBe(resetsBeforeUint8 + 1);

        // 5) Real Hub binary CONTROL_JSON agent_offline closes WS cleanly (fallback ws.close() when 1012 throws in browser)
        session.notifyAgentDisconnected();
        await waitFor(() => spawnedSockets.every((s) => s.readyState === WebSocket.CLOSED));
      } finally {
        hookReturn?.clearReconnectTimers?.();
        for (const s of spawnedSockets) {
          try { s.terminate(); } catch {}
        }
        if (origWebSocket === undefined) delete (globalThis as any).WebSocket;
        else (globalThis as any).WebSocket = origWebSocket;
        if (origWindow === undefined) delete (globalThis as any).window;
        else (globalThis as any).window = origWindow;
        terminalHostManager.unregisterAgent('hook-rt-host', agentWs);
        try {
          (wss as any).closeAllClients?.(1001, 'Done');
          wss.close();
        } catch {}
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('prevents synchronous close race during unexpected-response 401 across exec, interactiveExec, and CliTcpTunnelClient', async () => {
      class SyncTerminateWs extends EventEmitter {
        public static OPEN = 1;
        public OPEN = 1;
        public readyState = 0;
        constructor() {
          super();
          queueMicrotask(() => {
            this.emit('unexpected-response', { destroy: jest.fn() }, { statusCode: 401, resume: jest.fn() });
          });
        }
        terminate() {
          this.readyState = 3;
          // Synchronously emit close before unexpected-response returns
          this.emit('close', 1006, Buffer.from('abnormal'));
        }
        close() {
          this.terminate();
        }
        send() {}
      }

      let execErr: any = null;
      let interactiveErrText = '';
      let interactiveCode = -1;
      let tunnelErr: any = null;

      await new Promise<void>((resolve, reject) => {
        jest.isolateModules(() => {
          jest.doMock('ws', () => SyncTerminateWs);
          const { runStreamExec: isolatedExec } = require('../src/client/commands/exec');
          const { runInteractiveExec: isolatedInteractive } = require('../src/client/interactive/interactiveExec');
          const { CliTcpTunnelClient: IsolatedTunnel } = require('../src/client/commands/proxy');

          const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
            interactiveErrText += String(chunk);
            return true;
          });
          const consoleErrSpy = jest.spyOn(console, 'error').mockImplementation((...args: any[]) => {
            interactiveErrText += args.join(' ');
          });

          Promise.all([
            isolatedExec({
              serverUrl: 'http://127.0.0.1:9999',
              apiKey: '',
              hostId: 'h1',
              fullCommand: 'echo hi',
              options: { detach: false, timeoutMs: 5000, verbose: false, pollInterval: 50, env: {}, interactive: false, tty: false, mode: 'stream' },
              startTime: Date.now(),
            }).catch((e: any) => { execErr = e; }),
            isolatedInteractive({
              serverUrl: 'http://127.0.0.1:9999',
              apiKey: '',
              hostId: 'h1',
              fullCommand: 'bash',
              options: { tty: false },
            }).then((c: number) => { interactiveCode = c; }),
            new IsolatedTunnel({ serverUrl: 'http://127.0.0.1:9999', apiKey: '', hostId: 'h1' })
              .connect()
              .catch((e: any) => { tunnelErr = e; }),
          ]).then(() => {
            stderrSpy.mockRestore();
            consoleErrSpy.mockRestore();
            resolve();
          }, (err) => {
            stderrSpy.mockRestore();
            consoleErrSpy.mockRestore();
            reject(err);
          });
        });
      });

      expect(execErr).toMatchObject({ allowHttpFallback: false, statusCode: 401 });
      expect(interactiveCode).toBe(1);
      expect(interactiveErrText).toContain('HTTP 401');
      expect(interactiveErrText).not.toContain('[Connection Closed]');
      expect(tunnelErr?.message).toContain('HTTP 401');
    });
  });
});
