import http from 'http';
import { URL } from 'url';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import config from '../../../config/default';
import logger from '../../utils/logger';
import { terminalHostManager } from '../services/terminalHostManager';
import { terminalExecBridge } from '../services/terminalExecBridge';

export function setupTerminalWebSocket(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const agentWss = new WebSocketServer({ noServer: true });
  const execWss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req: http.IncomingMessage, socket: any, head: Buffer) => {
    const reqUrl = req.url || '';
    const isClientWs = reqUrl.startsWith('/api/terminal/ws') || reqUrl.startsWith('/api/admin/terminal/ws');
    const isAgentWs = reqUrl.startsWith('/api/terminal/agent-ws') || reqUrl.startsWith('/api/admin/terminal/agent-ws');
    const isExecWs = reqUrl.startsWith('/api/terminal/exec-ws') || reqUrl.startsWith('/api/admin/terminal/exec-ws');

    if (!isClientWs && !isAgentWs && !isExecWs) {
      return;
    }

    const secretKey = config.adminSecretKey;
    if (secretKey) {
      const parsedUrl = new URL(reqUrl, `http://${req.headers.host || 'localhost'}`);
      const providedKey =
        req.headers['x-admin-key'] ||
        parsedUrl.searchParams.get('x-admin-key') ||
        parsedUrl.searchParams.get('key');

      if (providedKey !== secretKey) {
        logger.warn(`[TerminalWS] Unauthorized WebSocket connection attempt rejected (${reqUrl})`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    if (isAgentWs) {
      agentWss.handleUpgrade(req, socket, head, (ws) => {
        agentWss.emit('connection', ws, req);
      });
    } else if (isExecWs) {
      execWss.handleUpgrade(req, socket, head, (ws) => {
        terminalExecBridge.handleCliConnection(ws, req);
      });
    } else {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  };

  server.on('upgrade', onUpgrade);

  wss.on('close', () => {
    try {
      agentWss.close();
      execWss.close();
    } catch {}
    server.removeListener('upgrade', onUpgrade);
  });

  // Agent Reverse Tunnel Handler
  agentWss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const parsedUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const hostId = parsedUrl.searchParams.get('hostId') || parsedUrl.searchParams.get('id') || `agent-${Date.now()}`;
    const name = parsedUrl.searchParams.get('name') || undefined;
    const hostname = parsedUrl.searchParams.get('hostname') || undefined;
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
      req.socket.remoteAddress ||
      parsedUrl.searchParams.get('ip') ||
      undefined;
    const platform = parsedUrl.searchParams.get('platform') || undefined;

    const agentMeta = { hostId, name, hostname, ip, platform };
    (ws as any)._agentMeta = agentMeta;

    const regResult = terminalHostManager.registerAgent({
      hostId,
      name,
      hostname,
      ip,
      platform,
      agentWs: ws,
    });

    if (!regResult.success) {
      logger.warn(`[TerminalWS:Agent] Registration rejected for ${hostId} (${name}): ${regResult.error}`);
      try {
        ws.send(`JSON:${JSON.stringify({ type: 'rejected', reason: regResult.error, code: 4009 })}`);
        ws.close(4009, regResult.error);
      } catch {}
      return;
    }

    const host = regResult.host!;
    logger.info(`[TerminalWS:Agent] Agent connected: ${hostId} (${host.name}) from ${ip}`);
    ws.send(`JSON:${JSON.stringify({ type: 'registered', hostId, status: 'online' })}`);

    ws.on('message', (message: RawData, isBinary: boolean) => {
      try {
        terminalHostManager.touchAgent(hostId, ws, agentMeta);

        if (isBinary) {
          terminalHostManager.handleAgentData(hostId, message);
          return;
        }

        const msgStr = typeof message === 'string' ? message : message.toString('utf-8');
        if (msgStr.startsWith('JSON:')) {
          const control = JSON.parse(msgStr.slice(5));
          if (control.type === 'ping') {
            ws.send(`JSON:${JSON.stringify({ type: 'pong' })}`);
            return;
          }
          if (control.type === 'meta') {
            const metaRes = terminalHostManager.registerAgent({
              hostId,
              name: control.name,
              hostname: control.hostname,
              ip: control.ip,
              platform: control.platform,
              agentWs: ws,
            });
            if (!metaRes.success) {
              logger.warn(`[TerminalWS:Agent] Meta update rejected for ${hostId}: ${metaRes.error}`);
              try {
                ws.send(`JSON:${JSON.stringify({ type: 'rejected', reason: metaRes.error, code: 4009 })}`);
                ws.close(4009, metaRes.error);
              } catch {}
            }
            return;
          }
          if (control.type === 'file_rpc_res') {
            terminalHostManager.handleAgentRpcResponse(control);
            return;
          }
          if (control.type === 'cmd_exec_res') {
            terminalHostManager.handleAgentCmdRpcResponse(control);
            return;
          }
          if (control.type === 'cmd_stream_data' || control.type === 'cmd_stream_exit') {
            terminalExecBridge.handleAgentStreamMessage(hostId, control);
            return;
          }
          if (control.type === 'reset') {
            const session = terminalHostManager.getSession(hostId);
            if (session) {
              session.reset(true, false);
            }
            return;
          }
          // Any other control frame is consumed here
          return;
        }
        terminalHostManager.handleAgentData(hostId, msgStr);
      } catch (err: any) {
        terminalHostManager.handleAgentData(hostId, message);
      }
    });

    ws.on('close', () => {
      logger.info(`[TerminalWS:Agent] Agent disconnected: ${hostId}`);
      if (terminalHostManager.isCurrentAgentWs(hostId, ws)) {
        terminalExecBridge.handleAgentDisconnected(hostId);
      }
      terminalHostManager.unregisterAgent(hostId, ws);
    });

    ws.on('error', (err) => {
      logger.error(`[TerminalWS:Agent] Agent socket error (${hostId}): ${err.message}`);
      if (terminalHostManager.isCurrentAgentWs(hostId, ws)) {
        terminalExecBridge.handleAgentDisconnected(hostId);
      }
      terminalHostManager.unregisterAgent(hostId, ws);
    });
  });

  // Client Web Terminal Connection Handler
  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    const parsedUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const hostId = (parsedUrl.searchParams.get('hostId') || '').trim();

    if (!hostId) {
      logger.warn('[TerminalWS] Interactive terminal client connected without hostId');
      ws.send('\r\n\x1b[33m[Host Offline] Host "" is offline or unavailable.\x1b[0m\r\n');
      ws.close(1008, 'hostId query parameter is required');
      return;
    }

    logger.info(`[TerminalWS] Interactive terminal client attached to host: ${hostId}`);
    const session = terminalHostManager.getSession(hostId);

    if (!session) {
      logger.warn(`[TerminalWS] No active session found for host: ${hostId}`);
      ws.send(`\r\n\x1b[33m[Host Offline] Host "${hostId}" is offline or unavailable.\x1b[0m\r\n`);
      ws.close(1008, 'Host session unavailable');
      return;
    }

    session.attach(ws);

    ws.on('message', (message: RawData) => {
      try {
        const msgStr = message.toString();
        if (msgStr.startsWith('JSON:')) {
          const control = JSON.parse(msgStr.slice(5));
          logger.debug(`[TerminalWS:${hostId}] Control frame: ${JSON.stringify(control)}`);
          if (
            control.type === 'resize' &&
            typeof control.cols === 'number' &&
            !Number.isNaN(control.cols) &&
            typeof control.rows === 'number' &&
            !Number.isNaN(control.rows)
          ) {
            const cols = Math.max(10, Math.min(500, Math.floor(control.cols)));
            const rows = Math.max(5, Math.min(200, Math.floor(control.rows)));
            session.resize(cols, rows);
            return;
          }
          if (control.type === 'reset') {
            logger.info(`[TerminalWS:${hostId}] Reset session requested by client`);
            session.reset(true, true);
            return;
          }
          if (control.type === 'ping') {
            ws.send(`JSON:${JSON.stringify({ type: 'pong' })}`);
            return;
          }
        }

        const hex = Buffer.from(msgStr).toString('hex');
        const preview = JSON.stringify(msgStr.length > 30 ? msgStr.slice(0, 30) + '...' : msgStr);
        logger.debug(`[TerminalWS:${hostId}] Raw input frame (len=${msgStr.length}, hex=${hex}, preview=${preview})`);
        session.write(msgStr);
      } catch (err: any) {
        logger.warn(`[TerminalWS:${hostId}] Message parse exception: ${err.message}`);
        session.write(message.toString());
      }
    });

    ws.on('close', () => {
      logger.info(`[TerminalWS:${hostId}] Client detached. Session remains active in background.`);
      session.detach(ws);
    });

    ws.on('error', (err) => {
      logger.error(`[TerminalWS:${hostId}] WebSocket error: ${err.message}`);
      session.detach(ws);
    });
  });

  return wss;
}
