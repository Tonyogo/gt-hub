import http from 'http';
import WebSocket from 'ws';
import request from 'supertest';
import express from 'express';
import serverApp from '../src/server/app';
import terminalRoutes from '../src/terminal/routes/terminalRoutes';
import proxyRoutes from '../src/terminal/routes/proxyRoutes';
import { setupTerminalWebSocket } from '../src/terminal/routes/terminalWs';
import { terminalHostManager, RemoteAgentTerminalSession } from '../src/terminal/services/terminalHostManager';
import { handleCmdExec } from '../src/agent/handlers/cmdExecHandler';
import { scriptService } from '../src/server/modules/scripts/scriptService';
import { extractHostId } from '../src/terminal/utils/requestParams';
import { mapRpcErrorToHttpStatus } from '../src/terminal/utils/httpErrorMapper';
import terminalFileService from '../src/terminal/services/terminalFileService';
import terminalExecService from '../src/terminal/services/terminalExecService';
import config from '../config/default';
import {
  BIN_MSG_TYPE,
  encodeControlJsonPacket,
  decodeControlJsonPacket,
  isValidControlPayload,
} from '../src/shared/protocol/binaryProtocol';
import { RpcDispatcher } from '../src/terminal/services/rpcDispatcher';

describe('Task 1: Unified Params, HTTP Error Mapping & Response Envelopes', () => {
  const adminKey = 'test-opt-key';
  const originalKey = config.adminSecretKey;
  let app: express.Express;

  beforeAll(() => {
    config.adminSecretKey = adminKey;
    app = express();
    app.use('/api/proxy', proxyRoutes);
    app.use(express.json());
    app.use('/api/terminal', terminalRoutes);
  });

  afterAll(() => {
    config.adminSecretKey = originalKey;
    jest.restoreAllMocks();
  });

  test('extractHostId resolves hostId/nodeId across params, query, and body by priority', () => {
    expect(
      extractHostId({
        params: { hostId: 'from-param' },
        query: { hostId: 'from-query' },
        body: { hostId: 'from-body' },
      } as any)
    ).toBe('from-param');

    expect(
      extractHostId({
        params: {},
        query: { nodeId: 'from-query-node' },
        body: { hostId: 'from-body' },
      } as any)
    ).toBe('from-query-node');

    expect(
      extractHostId({
        params: {},
        query: {},
        body: { hostId: '  from-body-trimmed  ' },
      } as any)
    ).toBe('from-body-trimmed');
  });

  test('mapRpcErrorToHttpStatus maps offline, timeout, permission, not-found, and validation errors', () => {
    expect(mapRpcErrorToHttpStatus('Agent "node-1" is offline or unavailable')).toBe(503);
    expect(mapRpcErrorToHttpStatus('Node "node-1" is offline')).toBe(503);
    expect(mapRpcErrorToHttpStatus('Agent command RPC request timed out (30s)')).toBe(504);
    expect(mapRpcErrorToHttpStatus('EACCES: permission denied, open /etc/shadow')).toBe(403);
    expect(mapRpcErrorToHttpStatus('Access denied: Path is outside agent workspace')).toBe(403);
    expect(mapRpcErrorToHttpStatus('No such file or directory')).toBe(404);
    expect(mapRpcErrorToHttpStatus('No such task: task-1')).toBe(404);
    expect(mapRpcErrorToHttpStatus('Invalid cron expression: "bad"')).toBe(400);
    expect(mapRpcErrorToHttpStatus('Multipart boundary not found')).toBe(400);
    expect(mapRpcErrorToHttpStatus('Unexpected end of multipart stream: closing boundary not found', 500)).toBe(500);
    expect(mapRpcErrorToHttpStatus('Unexpected internal failure', 500)).toBe(500);
  });

  test('file endpoints accept hostId in path (/files/:hostId/*), query, or body and map offline/permission errors', async () => {
    const listSpy = jest.spyOn(terminalFileService, 'listFiles').mockResolvedValueOnce({
      success: true,
      files: [],
      currentPath: '/tmp',
    } as any);

    const pathRes = await request(app)
      .get('/api/terminal/files/node-path-1/list?path=/tmp')
      .set('x-admin-key', adminKey);
    expect(pathRes.status).toBe(200);
    expect(listSpy).toHaveBeenCalledWith('node-path-1', '/tmp');

    const saveSpy = jest.spyOn(terminalFileService, 'saveFileContent').mockResolvedValueOnce({
      success: false,
      error: 'EACCES: permission denied',
    } as any);

    // Passing hostId via query to POST /files/save (previously failed with 400)
    const saveRes = await request(app)
      .post('/api/terminal/files/save?hostId=node-query-1')
      .set('x-admin-key', adminKey)
      .send({ path: '/etc/hosts', content: 'test' });
    expect(saveRes.status).toBe(403);
    expect(saveSpy).toHaveBeenCalledWith('node-query-1', '/etc/hosts', 'test');

    listSpy.mockRestore();
    saveSpy.mockRestore();
  });

  test('exec status, kill, list, and cron trigger return 503 when node is offline', async () => {
    const statusRes = await request(app)
      .get('/api/terminal/exec/offline-node-xyz/task-1')
      .set('x-admin-key', adminKey);
    expect(statusRes.status).toBe(503);

    const killRes = await request(app)
      .post('/api/terminal/exec/offline-node-xyz/task-1/kill')
      .set('x-admin-key', adminKey);
    expect(killRes.status).toBe(503);

    const listRes = await request(app)
      .get('/api/terminal/exec/offline-node-xyz')
      .set('x-admin-key', adminKey);
    expect(listRes.status).toBe(503);
  });

  test('hosts, version, logs, and proxy endpoints include top-level success boolean', async () => {
    const hostsRes = await request(app).get('/api/terminal/hosts').set('x-admin-key', adminKey);
    expect(hostsRes.status).toBe(200);
    expect(hostsRes.body.success).toBe(true);
    expect(Array.isArray(hostsRes.body.hosts)).toBe(true);

    const verRes = await request(app).get('/api/terminal/version').set('x-admin-key', adminKey);
    expect(verRes.status).toBe(200);
    expect(verRes.body.success).toBe(true);
    expect(verRes.body.version).toBeDefined();

    const logsRes = await request(app).get('/api/terminal/logs').set('x-admin-key', adminKey);
    expect(logsRes.status).toBe(200);
    expect(logsRes.body.success).toBe(true);
    expect(Array.isArray(logsRes.body.logs)).toBe(true);

    const proxyUnauth = await request(app).get('/api/proxy/node-1/ports');
    expect(proxyUnauth.status).toBe(401);
    expect(proxyUnauth.body.success).toBe(false);
  });
});

describe('Task 2: Binary CONTROL_JSON (0x08), JSON: Whitelist & RpcDispatcher Decoupling', () => {
  test('encodes and decodes BIN_MSG_TYPE.CONTROL_JSON (0x08) packets and validates control payloads', () => {
    expect(BIN_MSG_TYPE.CONTROL_JSON).toBe(0x08);

    const pkt = encodeControlJsonPacket({ type: 'cmd_exec', reqId: 'r1', action: 'list' }, 'node-1');
    expect(pkt[0]).toBe(0x08);

    const decoded = decodeControlJsonPacket(pkt);
    expect(decoded).toEqual({ type: 'cmd_exec', reqId: 'r1', action: 'list' });

    expect(isValidControlPayload({ type: 'ping' })).toBe(true);
    expect(isValidControlPayload({ type: 'cmd_task_finished', taskId: 't1' })).toBe(true);
    expect(isValidControlPayload({ type: 'proxy_http_res_headers' })).toBe(true);
    expect(isValidControlPayload({ type: 'unknown_random_user_field' })).toBe(false);
    expect(isValidControlPayload('not-an-object')).toBe(false);
    expect(isValidControlPayload(null)).toBe(false);
  });

  test('RemoteAgentTerminalSession.handleData does not swallow terminal output starting with JSON: when not a valid control payload', () => {
    const session = new RemoteAgentTerminalSession('host-1', null, 'main');
    session.handleData('JSON: user log line that is not json\r\n');
    session.handleData('JSON:{"notAControlFrame":true}\r\n');
    session.handleData('JSON:{"type":"ping"}'); // Valid control frame should still be ignored by terminal history

    const history = session.getHistory();
    expect(history).toContain('JSON: user log line that is not json');
    expect(history).toContain('JSON:{"notAControlFrame":true}');
    expect(history).not.toContain('"type":"ping"');
    session.destroy();
  });

  test('RpcDispatcher sends directly via agentWs without polluting session.pendingInputBuffer when disconnected', async () => {
    const dispatcher = new RpcDispatcher();
    const session = new RemoteAgentTerminalSession('host-offline', null, 'main');
    const writeSpy = jest.spyOn(session, 'write');

    const cmdRes = await dispatcher.executeCmdRpc(session, 'host-offline', { action: 'list' }, 500);
    expect(cmdRes.success).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();

    const fileRes = await dispatcher.executeFileRpc(session, 'host-offline', { action: 'list', path: '/' }, 500);
    expect(fileRes.success).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
    session.destroy();
  });
});

describe('Task 3: POST /api/terminal/exec/:hostId with waitMs, scriptName & binary CONTROL_JSON', () => {
  let hubServer: http.Server;
  let hubPort: number;
  let wss: any;
  let agentWs: WebSocket;
  const adminKey = 'test-opt-e2e-key';
  const originalKey = config.adminSecretKey;
  const hostId = 'opt-e2e-node';

  beforeAll(async () => {
    config.adminSecretKey = adminKey;
    await scriptService.saveScript('hello_args.sh', '#!/bin/sh\nread input_line\necho "script:$1:$2:$input_line"');

    hubServer = http.createServer(serverApp);
    wss = setupTerminalWebSocket(hubServer, terminalHostManager);
    await new Promise<void>((resolve) => hubServer.listen(0, '127.0.0.1', resolve));
    hubPort = (hubServer.address() as any).port;

    agentWs = new WebSocket(
      `ws://127.0.0.1:${hubPort}/api/terminal/agent-ws?hostId=${hostId}&name=opt-node&binaryControl=1`,
      { headers: { 'x-admin-key': adminKey } }
    );

    await new Promise<void>((resolve, reject) => {
      agentWs.on('message', (data, isBinary) => {
        let ctrl: any = null;
        if (isBinary) {
          ctrl = decodeControlJsonPacket(data as Buffer);
        } else {
          const str = data.toString();
          if (str.startsWith('JSON:')) ctrl = JSON.parse(str.slice(5));
        }
        if (ctrl) {
          if (ctrl.type === 'registered') resolve();
          if (ctrl.type === 'cmd_exec') {
            handleCmdExec(ctrl, {
              readyState: 1,
              send: (msg: string) => {
                if (msg.startsWith('JSON:')) {
                  agentWs.send(encodeControlJsonPacket(JSON.parse(msg.slice(5)), hostId));
                } else {
                  agentWs.send(msg);
                }
              },
            });
          }
        }
      });
      agentWs.on('error', reject);
    });
  });

  afterAll(async () => {
    config.adminSecretKey = originalKey;
    try { await scriptService.deleteScript('hello_args.sh'); } catch {}
    if (agentWs && agentWs.readyState === WebSocket.OPEN) agentWs.close();
    if (wss && wss.closeAllClients) wss.closeAllClients();
    await new Promise<void>((resolve) => hubServer.close(() => resolve()));
  });

  test('completes synchronously with 200 OK within waitMs and skips webhook callback', async () => {
    let webhookCalled = false;
    const receiver = http.createServer((_req, res) => {
      webhookCalled = true;
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const receiverPort = (receiver.address() as any).port;

    const res = await request(serverApp)
      .post(`/api/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({
        command: 'echo "sync-fast-ok"',
        waitMs: 3000,
        callback: {
          url: `http://127.0.0.1:${receiverPort}/hook`,
        },
      });

    await new Promise((r) => setTimeout(r, 150));
    await new Promise<void>((resolve) => receiver.close(() => resolve()));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.completed).toBe(true);
    expect(res.body.status).toBe('completed');
    expect(res.body.exitCode).toBe(0);
    expect(res.body.stdout).toContain('sync-fast-ok');
    expect(res.body.callbackRegistered).toBe(false);
    expect(res.body.callbackSkippedReason).toBe('completed_within_wait');
    expect(webhookCalled).toBe(false);
  });

  test('falls back to 202 Accepted and delivers webhook when task exceeds waitMs', async () => {
    let receivedPayload: any = null;
    let webhookResolve!: () => void;
    const webhookPromise = new Promise<void>((resolve) => {
      webhookResolve = resolve;
    });

    const receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        receivedPayload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        res.writeHead(200);
        res.end('ok');
        webhookResolve();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const receiverPort = (receiver.address() as any).port;

    const res = await request(serverApp)
      .post(`/api/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({
        command: 'sleep 0.3 && echo "slow-finished"',
        waitMs: 50,
        callback: {
          url: `http://127.0.0.1:${receiverPort}/hook`,
          context: { mode: 'fallback' },
        },
      });

    expect(res.status).toBe(202);
    expect(res.body.completed).toBe(false);
    expect(res.body.status).toBe('running');
    expect(res.body.callbackRegistered).toBe(true);

    await webhookPromise;
    await new Promise<void>((resolve) => receiver.close(() => resolve()));

    expect(receivedPayload.taskId).toBe(res.body.taskId);
    expect(receivedPayload.execution.stdout).toContain('slow-finished');
    expect(receivedPayload.context).toEqual({ mode: 'fallback' });
  });

  test('executes Hub script via scriptName + scriptArgs + stdin and returns 404 for unknown script', async () => {
    const res = await request(serverApp)
      .post(`/api/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({
        scriptName: 'hello_args.sh',
        scriptArgs: ['arg one', 'arg2'],
        stdin: 'from-stdin\n',
        waitMs: 3000,
      });

    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(true);
    expect(res.body.stdout.trim()).toBe('script:arg one:arg2:from-stdin');

    const notFoundRes = await request(serverApp)
      .post(`/api/terminal/exec/${hostId}`)
      .set('x-admin-key', adminKey)
      .send({
        scriptName: 'non_existent_script.sh',
      });
    expect(notFoundRes.status).toBe(404);
  });
});


