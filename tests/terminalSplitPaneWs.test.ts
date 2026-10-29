import http from 'http';
import WebSocket from 'ws';
import express from 'express';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { TerminalHostManager } from '../src/terminal/services/terminalHostManager';
import { BIN_MSG_TYPE, encodeBinaryPacket, decodeBinaryPacket } from '../src/shared/protocol/binaryProtocol';
import config from '../config/default';

describe('Terminal WebSocket Split-Pane Multiplexing', () => {
  let server: http.Server;
  let port: number;
  let wss: any;
  let hostMgr: TerminalHostManager;
  const originalKey = config.adminSecretKey;

  beforeEach((done) => {
    config.adminSecretKey = 'split-ws-key';
    hostMgr = new TerminalHostManager();
    const app = express();
    server = http.createServer(app);
    wss = setupTerminalWebSocket(server, hostMgr);
    server.listen(0, () => {
      port = (server.address() as any).port;
      done();
    });
  });

  afterEach((done) => {
    config.adminSecretKey = originalKey;
    if (wss) {
      try { wss.close(); } catch {}
    }
    if (typeof (server as any).closeAllConnections === 'function') {
      (server as any).closeAllConnections();
    }
    server.close(done);
  });

  it('multiplexes main and split pane I/O, resize, pane_close, and pane_exit independently', (done) => {
    const hostId = 'host-mux-1';
    const agentWs = new WebSocket(
      `ws://127.0.0.1:${port}/api/terminal/agent-ws?hostId=${hostId}&name=MuxNode&key=split-ws-key`
    );

    const agentReceivedControls: any[] = [];
    const agentReceivedSplitInputs: string[] = [];

    agentWs.on('open', () => {
      const mainClient = new WebSocket(
        `ws://127.0.0.1:${port}/api/terminal/ws?hostId=${hostId}&paneId=main&key=split-ws-key`
      );
      const splitClient = new WebSocket(
        `ws://127.0.0.1:${port}/api/terminal/ws?hostId=${hostId}&paneId=split&key=split-ws-key`
      );

      let mainOutput = '';
      let splitOutput = '';
      let splitExited = false;

      agentWs.on('message', (data, isBinary) => {
        if (isBinary) {
          const decoded = decodeBinaryPacket(Buffer.from(data as any));
          if (decoded && decoded.msgType === BIN_MSG_TYPE.TERMINAL_RAW && decoded.id === 'split') {
            agentReceivedSplitInputs.push(decoded.payload.toString('utf-8'));
            // Echo back to split pane only
            agentWs.send(encodeBinaryPacket(BIN_MSG_TYPE.TERMINAL_RAW, 'split', 'SPLIT_ACK\r\n'));
          }
          return;
        }
        const str = data.toString();
        if (str.startsWith('JSON:')) {
          const ctrl = JSON.parse(str.slice(5));
          agentReceivedControls.push(ctrl);
          if (ctrl.type === 'pane_close' && ctrl.paneId === 'split') {
            // Simulate agent confirming exit or closing
            mainClient.close();
            splitClient.close();
            agentWs.close();
            expect(mainOutput).toContain('MAIN_ACK');
            expect(mainOutput).not.toContain('SPLIT_ACK');
            expect(splitOutput).toContain('SPLIT_ACK');
            expect(splitOutput).not.toContain('MAIN_ACK');
            expect(agentReceivedSplitInputs).toContain('echo split\n');
            expect(splitExited).toBe(true);
            done();
          }
          return;
        }
        if (str === 'echo main\n') {
          agentWs.send('MAIN_ACK\r\n');
        }
      });

      let openCount = 0;
      const onBothClientsOpen = () => {
        openCount++;
        if (openCount < 2) return;
        mainClient.send(`JSON:${JSON.stringify({ type: 'resize', cols: 80, rows: 24 })}`);
        splitClient.send(`JSON:${JSON.stringify({ type: 'resize', cols: 40, rows: 24 })}`);
        mainClient.send('echo main\n');
        splitClient.send('echo split\n');
      };

      mainClient.on('open', onBothClientsOpen);
      splitClient.on('open', onBothClientsOpen);

      mainClient.on('message', (msg) => {
        mainOutput += msg.toString();
      });

      splitClient.on('message', (msg) => {
        const str = msg.toString();
        if (str.startsWith('JSON:')) {
          const parsed = JSON.parse(str.slice(5));
          if (parsed.type === 'pane_exit' && parsed.paneId === 'split') {
            splitExited = true;
            // Now test client sending pane_close
            splitClient.send(`JSON:${JSON.stringify({ type: 'pane_close' })}`);
          }
          return;
        }
        splitOutput += str;
        if (splitOutput.includes('SPLIT_ACK') && !splitExited) {
          agentWs.send(`JSON:${JSON.stringify({ type: 'pane_exit', paneId: 'split', exitCode: 0 })}`);
        }
      });
    });
  });
});
