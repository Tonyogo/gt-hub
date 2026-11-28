import http from 'http';
import { URL } from 'url';
import { WebSocketServer, WebSocket, RawData } from 'ws';
import config from '../../../config/default';
import logger from '../../utils/logger';
import { safeCompareSecret, extractAdminKeyFromRequest } from '../../shared/utils/security';
import { terminalHostManager, TerminalHostManager } from '../services/terminalHostManager';
import { terminalExecBridge } from '../services/terminalExecBridge';
import { terminalExecService } from '../services/terminalExecService';
import { terminalProxyBridge } from '../services/terminalProxyBridge';
import { ticketManager } from '../../server/modules/auth/ticketManager';
import { terminalCronService } from '../services/terminalCronService';
import {
  BIN_MSG_TYPE,
  PROTOCOL_VERSION,
  decodeBinaryPacket,
  decodeBinaryJsonBufferPacket,
  decodeControlJsonPacket,
  isBinaryMessageFrame,
  isValidControlPayload,
  negotiateProtocolCapabilities,
  sendControlFrame,
} from '../../shared/protocol/binaryProtocol';
import { TERMINAL_WS_DEFLATE_OPTIONS } from '../../shared/protocol/wsOptions';
import { loginRateLimiter, extractClientIp } from '../../server/modules/auth/rateLimiter';

const SENSITIVE_QUERY_KEYS = new Set(['key', 'x-admin-key', 'admin_key', 'ticket']);

export function redactWsUrlSecrets(rawUrl: string): string {
  if (!rawUrl || !rawUrl.includes('?')) return rawUrl;
  try {
    const parsed = new URL(rawUrl, 'http://localhost');
    let mutated = false;
    for (const k of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(k.toLowerCase())) {
        parsed.searchParams.set(k, '***');
        mutated = true;
      }
    }
    return mutated ? `${parsed.pathname}${parsed.search}` : rawUrl;
  } catch {
    return rawUrl.split('?')[0];
  }
}

export interface SetupTerminalWsOptions {
  agentHeartbeatIntervalMs?: number;
  agentHeartbeatTimeoutMs?: number;
}

export function setupTerminalWebSocket(
  server: http.Server,
  hostManagerInstance?: any,
  options: SetupTerminalWsOptions = {}
): WebSocketServer {
  const hostMgr = hostManagerInstance || terminalHostManager;
  const agentHeartbeatIntervalMs = options.agentHeartbeatIntervalMs ?? 30000;
  const agentHeartbeatTimeoutMs = options.agentHeartbeatTimeoutMs ?? 75000;
  const agentHeartbeatTimers = new Set<NodeJS.Timeout>();
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: TERMINAL_WS_DEFLATE_OPTIONS });
  const agentWss = new WebSocketServer({ noServer: true, perMessageDeflate: TERMINAL_WS_DEFLATE_OPTIONS });
  const execWss = new WebSocketServer({ noServer: true, perMessageDeflate: TERMINAL_WS_DEFLATE_OPTIONS });
  const proxyWss = new WebSocketServer({ noServer: true, perMessageDeflate: TERMINAL_WS_DEFLATE_OPTIONS });

  const onUpgrade = (req: http.IncomingMessage, socket: any, head: Buffer) => {
    const reqUrl = req.url || '';
    const isTerminalPrefix = reqUrl.startsWith('/api/terminal/') || reqUrl.startsWith('/api/admin/terminal/');
    if (!isTerminalPrefix) {
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(reqUrl, `http://${req.headers.host || 'localhost'}`);
    } catch {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    const pathname = parsedUrl.pathname.replace(/\/+$/, '');
    const isClientWs = pathname === '/api/terminal/ws' || pathname === '/api/admin/terminal/ws';
    const isAgentWs = pathname === '/api/terminal/agent-ws' || pathname === '/api/admin/terminal/agent-ws';
    const isExecWs = pathname === '/api/terminal/exec-ws' || pathname === '/api/admin/terminal/exec-ws';
    const isProxyWs = pathname === '/api/terminal/proxy-ws' || pathname === '/api/admin/terminal/proxy-ws';

    if (!isClientWs && !isAgentWs && !isExecWs && !isProxyWs) {
      return;
    }

    const clientIp = extractClientIp(req);
    const rateStatus = loginRateLimiter.isRateLimited(clientIp);
    if (rateStatus.limited) {
      socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${rateStatus.retryAfterSec}\r\n\r\n`);
      socket.destroy();
      return;
    }

    const secretKey = config.adminSecretKey;
    if (secretKey) {
      const ticketParam = parsedUrl.searchParams.get('ticket');
      let isAuthorized = false;

      // 1. Ticket validation (preferred for browser connections)
      if (ticketParam && ticketManager.consumeTicket(ticketParam)) {
        isAuthorized = true;
      }

      // 2. Admin key extraction (x-admin-key, Authorization Bearer, query params)
      if (!isAuthorized) {
        const providedKey = extractAdminKeyFromRequest({
          headers: req.headers as Record<string, unknown>,
          url: reqUrl,
        });
        if (safeCompareSecret(providedKey, secretKey)) {
          isAuthorized = true;
        }
      }

      if (!isAuthorized) {
        loginRateLimiter.recordFailure(clientIp);
        logger.warn(`[TerminalWS] Unauthorized WebSocket connection attempt rejected (${redactWsUrlSecrets(reqUrl)})`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      loginRateLimiter.clear(clientIp);
    }

    if (isAgentWs) {
      agentWss.handleUpgrade(req, socket, head, (ws) => {
        agentWss.emit('connection', ws, req);
      });
    } else if (isExecWs) {
      execWss.handleUpgrade(req, socket, head, (ws) => {
        terminalExecBridge.handleCliConnection(ws, req);
      });
    } else if (isProxyWs) {
      proxyWss.handleUpgrade(req, socket, head, (ws) => {
        terminalProxyBridge.handleCliConnection(ws, req);
      });
    } else {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    }
  };

  server.on('upgrade', onUpgrade);

  const closeAllClients = (code = 1001, reason = 'Server shutting down') => {
    for (const timer of agentHeartbeatTimers) {
      clearInterval(timer);
    }
    agentHeartbeatTimers.clear();
    const allServers = [wss, agentWss, execWss, proxyWss];
    for (const wsServer of allServers) {
      for (const client of wsServer.clients) {
        try {
          if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
            client.close(code, reason);
          }
        } catch {}
      }
    }
  };
  (wss as any).closeAllClients = closeAllClients;

  wss.on('close', () => {
    try {
      closeAllClients(1001, 'Server shutting down');
      agentWss.close();
      execWss.close();
      proxyWss.close();
    } catch {}
    server.removeListener('upgrade', onUpgrade);
  });

  // Agent Reverse Tunnel Handler
  agentWss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    if (req.socket && typeof (req.socket as any).setKeepAlive === 'function') {
      (req.socket as any).setKeepAlive(true, 10000);
    }
    const parsedUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const rawHostId = parsedUrl.searchParams.get('hostId') || parsedUrl.searchParams.get('id') || '';
    const hostId = rawHostId.trim() || `agent-${Date.now()}`;
    const name = parsedUrl.searchParams.get('name') || undefined;
    const hostname = parsedUrl.searchParams.get('hostname') || undefined;
    const ip =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
      req.socket.remoteAddress ||
      parsedUrl.searchParams.get('ip') ||
      undefined;
    const platform = parsedUrl.searchParams.get('platform') || undefined;
    const machineId = parsedUrl.searchParams.get('machineId') || hostId;
    const version = parsedUrl.searchParams.get('version') || undefined;
    const startTimeParam = parsedUrl.searchParams.get('startTime');
    const parsedStartTime = startTimeParam ? parseInt(startTimeParam, 10) : undefined;
    const startTime = (parsedStartTime && !isNaN(parsedStartTime)) ? parsedStartTime : undefined;
    const caps = negotiateProtocolCapabilities(parsedUrl.searchParams);
    if (caps.binaryControl) {
      (ws as any)._binaryControl = true;
    }
    if (caps.binaryFile) {
      (ws as any)._binaryFile = true;
    }
    if (caps.framedTerminal) {
      (ws as any)._framedTerminal = true;
    }
    (ws as any)._protocolVersion = caps.protocolVersion;
    const agentMeta = { hostId, name, hostname, ip, platform, machineId, version, startTime };
    (ws as any)._agentMeta = agentMeta;

    const regResult = hostMgr.registerAgent({
      hostId,
      name,
      hostname,
      ip,
      platform,
      machineId,
      version,
      startTime,
      agentWs: ws,
    });

    if (!regResult.success) {
      logger.warn(`[TerminalWS:Agent] Registration rejected for ${hostId} (${name}): ${regResult.error}`);
      try {
        sendControlFrame(ws, { type: 'rejected', reason: regResult.error, code: 4009 }, hostId);
        ws.close(4009, regResult.error);
      } catch {}
      return;
    }

    const host = regResult.host!;
    logger.info(`[TerminalWS:Agent] Agent connected: ${hostId} (${host.name}) from ${ip}`);
    sendControlFrame(
      ws,
      {
        type: 'registered',
        hostId,
        name: host.name,
        status: 'online',
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          binaryControl: Boolean((ws as any)._binaryControl),
          binaryFile: Boolean((ws as any)._binaryFile),
          framedTerminal: Boolean((ws as any)._framedTerminal),
        },
      },
      hostId
    );
    terminalCronService.syncOnConnect(hostId);

    let lastTouch = 0;
    let lastAgentActivityAt = Date.now();
    let heartbeatSweepTimer: NodeJS.Timeout | null = null;

    const stopAgentHeartbeatSweep = () => {
      if (heartbeatSweepTimer) {
        clearInterval(heartbeatSweepTimer);
        agentHeartbeatTimers.delete(heartbeatSweepTimer);
        heartbeatSweepTimer = null;
      }
    };

    if (agentHeartbeatIntervalMs > 0 && agentHeartbeatTimeoutMs > 0) {
      heartbeatSweepTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          stopAgentHeartbeatSweep();
          return;
        }
        const idleMs = Date.now() - lastAgentActivityAt;
        if (idleMs > agentHeartbeatTimeoutMs) {
          logger.warn(
            `[TerminalWS:Agent] Agent liveness timeout (>${Math.round(agentHeartbeatTimeoutMs / 1000)}s idle) for ${hostId}; terminating stale socket`
          );
          stopAgentHeartbeatSweep();
          try {
            ws.terminate();
          } catch {}
          return;
        }
        if (idleMs >= agentHeartbeatIntervalMs && typeof (ws as any).ping === 'function') {
          try {
            (ws as any).ping();
          } catch {}
        }
      }, agentHeartbeatIntervalMs);
      if (typeof heartbeatSweepTimer.unref === 'function') {
        heartbeatSweepTimer.unref();
      }
      agentHeartbeatTimers.add(heartbeatSweepTimer);
    }

    const dispatchAgentControl = (control: Record<string, any>, now: number): boolean => {
      if (terminalProxyBridge.handleAgentControlMessage(hostId, control)) {
        return true;
      }
      if (control.type === 'ping') {
        lastTouch = now;
        hostMgr.touchAgent(hostId, ws, agentMeta);
        sendControlFrame(ws, { type: 'pong' }, hostId);
        return true;
      }
      if (control.type === 'meta') {
        const metaRes = hostMgr.registerAgent({
          hostId,
          name: control.name,
          hostname: control.hostname,
          ip: control.ip,
          platform: control.platform,
          machineId,
          version: control.version || version,
          startTime: control.startTime || startTime,
          agentWs: ws,
        });
        if (metaRes.success) {
          terminalCronService.syncOnConnect(hostId);
        }
        if (!metaRes.success) {
          logger.warn(`[TerminalWS:Agent] Meta update rejected for ${hostId}: ${metaRes.error}`);
          try {
            sendControlFrame(ws, { type: 'rejected', reason: metaRes.error, code: 4009 }, hostId);
            ws.close(4009, metaRes.error);
          } catch {}
        }
        return true;
      }
      if (control.type === 'file_rpc_res') {
        hostMgr.handleAgentRpcResponse(control);
        return true;
      }
      if (control.type === 'cmd_exec_res') {
        hostMgr.handleAgentCmdRpcResponse(control);
        return true;
      }
      if (control.type === 'cmd_task_finished') {
        terminalExecService.handleAgentTaskFinished(hostId, control);
        return true;
      }
      if (control.type === 'cmd_stream_data' || control.type === 'cmd_stream_exit') {
        if (typeof control.taskId === 'string' && control.taskId.startsWith('pane-')) {
          const paneId = control.taskId.slice(5);
          if (control.type === 'cmd_stream_data' && control.data) {
            hostMgr.handleAgentPaneData(hostId, paneId, Buffer.from(control.data, 'base64'));
          } else if (control.type === 'cmd_stream_exit') {
            hostMgr.handleAgentPaneExit(hostId, paneId, control.exitCode);
          }
          return true;
        }
        terminalExecBridge.handleAgentStreamMessage(hostId, control);
        return true;
      }
      if (control.type === 'history_sync') {
        if (control.paneId && control.paneId !== 'main') {
          hostMgr.handleAgentPaneHistorySync(hostId, control.paneId, control.history);
        } else {
          hostMgr.handleAgentHistorySync(hostId, control.history);
        }
        return true;
      }
      if (control.type === 'cron_report' && control.record) {
        terminalCronService.recordExecution(hostId, control.record);
        return true;
      }
      if (control.type === 'reset') {
        const targetPane = control.paneId || 'main';
        const session = hostMgr.getSession(hostId, targetPane);
        if (session) {
          session.reset(true, false);
        }
        return true;
      }
      if (control.type === 'pane_exit') {
        hostMgr.handleAgentPaneExit(hostId, control.paneId || 'split', control.exitCode);
        return true;
      }
      return true;
    };

    ws.on('ping', () => {
      lastAgentActivityAt = Date.now();
      hostMgr.touchAgent(hostId, ws, agentMeta);
    });

    ws.on('pong', () => {
      lastAgentActivityAt = Date.now();
      hostMgr.touchAgent(hostId, ws, agentMeta);
    });

    ws.on('message', (message: RawData, isBinary: boolean) => {
      try {
        const now = Date.now();
        lastAgentActivityAt = now;
        if (now - lastTouch > 2000) {
          lastTouch = now;
          hostMgr.touchAgent(hostId, ws, agentMeta);
        }

        const isRawBuf = Buffer.isBuffer(message) || ArrayBuffer.isView(message) || message instanceof ArrayBuffer;
        const buf = isRawBuf
          ? Buffer.isBuffer(message)
            ? message
            : ArrayBuffer.isView(message)
              ? Buffer.from(message.buffer, message.byteOffset, message.byteLength)
              : Buffer.from(message as ArrayBuffer)
          : null;

        if (isBinaryMessageFrame(message, isBinary) && buf) {
          const firstByte = buf.length > 0 ? buf[0] : -1;
          const isPacketTag =
            firstByte >= BIN_MSG_TYPE.STREAM_INPUT && firstByte <= BIN_MSG_TYPE.FILE_CHUNK_RES;
          const decoded = isPacketTag ? decodeBinaryPacket(buf) : null;
          if (decoded && decoded.msgType === BIN_MSG_TYPE.CONTROL_JSON) {
            const ctrl = decodeControlJsonPacket(buf);
            if (ctrl) {
              dispatchAgentControl(ctrl, now);
              return;
            }
          }
          if (
            decoded &&
            (decoded.msgType === BIN_MSG_TYPE.PROXY_HTTP_RES_BODY ||
              decoded.msgType === BIN_MSG_TYPE.PROXY_TCP_DATA ||
              decoded.msgType === BIN_MSG_TYPE.PROXY_HTTP_REQ_BODY)
          ) {
            terminalProxyBridge.handleAgentBinaryFrame(hostId, decoded);
            return;
          }
          if (decoded && decoded.msgType === BIN_MSG_TYPE.STREAM_OUTPUT) {
            if (decoded.id && decoded.id.startsWith('pane-')) {
              const paneId = decoded.id.slice(5);
              hostMgr.handleAgentPaneData(hostId, paneId, decoded.payload);
              return;
            }
            terminalExecBridge.handleAgentStreamMessage(hostId, buf);
            return;
          }
          if (decoded && decoded.msgType === BIN_MSG_TYPE.TERMINAL_RAW) {
            hostMgr.handleAgentPaneData(hostId, decoded.id, decoded.payload);
            return;
          }
          if (decoded && decoded.msgType === BIN_MSG_TYPE.FILE_CHUNK_RES) {
            const pkt = decodeBinaryJsonBufferPacket(buf);
            if (pkt) {
              const { success = true, error = null, ...meta } = pkt.meta;
              hostMgr.handleAgentRpcResponse({
                type: 'file_rpc_res',
                reqId: pkt.id,
                success,
                data: {
                  ...meta,
                  rawBuffer: pkt.rawData,
                },
                error,
              });
              return;
            }
          }
          if (decoded && decoded.msgType === BIN_MSG_TYPE.HISTORY_SYNC) {
            if (decoded.id && decoded.id !== hostId) {
              hostMgr.handleAgentPaneHistorySync(hostId, decoded.id, decoded.payload);
            } else {
              hostMgr.handleAgentHistorySync(hostId, decoded.payload);
            }
            return;
          }
          if (isBinary === true) {
            if ((ws as any)._framedTerminal === true) {
              return;
            }
            hostMgr.handleAgentData(hostId, message);
            return;
          }
        }

        const msgStr = typeof message === 'string'
          ? message
          : (buf ? buf.toString('utf-8') : String(message));
        if (msgStr.startsWith('JSON:')) {
          let control: any = null;
          try {
            control = JSON.parse(msgStr.slice(5));
          } catch {}
          if (isValidControlPayload(control)) {
            dispatchAgentControl(control, now);
            return;
          }
        }
        hostMgr.handleAgentData(hostId, isRawBuf ? message : msgStr);
      } catch (err: any) {
        hostMgr.handleAgentData(hostId, message);
      }
    });

    ws.on('close', () => {
      stopAgentHeartbeatSweep();
      logger.info(`[TerminalWS:Agent] Agent disconnected: ${hostId}`);
      if (hostMgr.isCurrentAgentWs(hostId, ws)) {
        terminalExecBridge.handleAgentDisconnected(hostId);
        terminalProxyBridge.handleAgentDisconnected(hostId);
      }
      hostMgr.unregisterAgent(hostId, ws);
    });

    ws.on('error', (err) => {
      stopAgentHeartbeatSweep();
      logger.error(`[TerminalWS:Agent] Agent socket error (${hostId}): ${err.message}`);
      if (hostMgr.isCurrentAgentWs(hostId, ws)) {
        terminalExecBridge.handleAgentDisconnected(hostId);
        terminalProxyBridge.handleAgentDisconnected(hostId);
      }
      hostMgr.unregisterAgent(hostId, ws);
    });
  });

  // Client Web Terminal Connection Handler
  wss.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
    if (req.socket && typeof (req.socket as any).setKeepAlive === 'function') {
      (req.socket as any).setKeepAlive(true, 10000);
    }
    const parsedUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const hostId = (parsedUrl.searchParams.get('hostId') || '').trim();
    const binaryControl = parsedUrl.searchParams.get('binaryControl');
    if (binaryControl === '1' || binaryControl === 'true') {
      (ws as any)._binaryControl = true;
    }
    const paneId = (hostMgr && typeof (hostMgr.constructor as typeof TerminalHostManager).normalizePaneId === 'function')
      ? (hostMgr.constructor as typeof TerminalHostManager).normalizePaneId(parsedUrl.searchParams.get('paneId'))
      : TerminalHostManager.normalizePaneId(parsedUrl.searchParams.get('paneId'));

    if (!hostId) {
      logger.warn('[TerminalWS] Interactive terminal client connected without hostId');
      ws.send('\r\n\x1b[33m[Host Offline] Host "" is offline or unavailable.\x1b[0m\r\n');
      ws.close(1008, 'hostId query parameter is required');
      return;
    }

    logger.info(`[TerminalWS] Interactive terminal client attached to host: ${hostId} (pane: ${paneId})`);
    const session = hostMgr.getSession(hostId, paneId);

    if (!session) {
      logger.warn(`[TerminalWS] No active session found for host: ${hostId} (pane: ${paneId})`);
      ws.send(`\r\n\x1b[33m[Host Offline] Host "${hostId}" is offline or unavailable.\x1b[0m\r\n`);
      ws.close(1008, 'Host session unavailable');
      return;
    }

    session.attach(ws);

    ws.on('message', (message: RawData, isBinary: boolean) => {
      let firstByte = -1;
      try {
        let control: any = null;
        if (isBinaryMessageFrame(message, isBinary)) {
          const buf = Buffer.isBuffer(message) ? message : Buffer.from(message as any);
          firstByte = buf.length > 0 ? buf[0] : -1;
          if (firstByte === BIN_MSG_TYPE.CONTROL_JSON) {
            control = decodeControlJsonPacket(buf);
            if (!control) {
              return;
            }
          } else if (isBinary === true && (ws as any)._binaryControl === true) {
            return;
          }
        }

        let msgStr = '';
        if (!control) {
          if (isBinary === true && (ws as any)._binaryControl === true) {
            return;
          }
          msgStr = typeof message === 'string' ? message : message.toString('utf-8');
          if (isBinary !== true && msgStr.startsWith('JSON:')) {
            try {
              const parsed = JSON.parse(msgStr.slice(5));
              if (isValidControlPayload(parsed)) {
                control = parsed;
              }
            } catch {}
          }
        }

        if (control) {
          if (config.logLevel === 'debug') {
            logger.debug(`[TerminalWS:${hostId}:${paneId}] Control frame: ${JSON.stringify(control)}`);
          }
          if (
            control.type === 'resize' &&
            typeof control.cols === 'number' &&
            !Number.isNaN(control.cols) &&
            typeof control.rows === 'number' &&
            !Number.isNaN(control.rows)
          ) {
            const cols = Math.max(10, Math.min(500, Math.floor(control.cols)));
            const rows = Math.max(5, Math.min(200, Math.floor(control.rows)));
            session.resize(cols, rows, Boolean(control.force));
            return;
          }
          if (control.type === 'reset') {
            logger.info(`[TerminalWS:${hostId}:${paneId}] Reset session requested by client`);
            session.reset(true, true);
            return;
          }
          if (control.type === 'pane_close') {
            logger.info(`[TerminalWS:${hostId}:${paneId}] Pane close requested by client`);
            hostMgr.destroyPaneSession(hostId, paneId, true);
            return;
          }
          if (control.type === 'ping') {
            sendControlFrame(ws, { type: 'pong' }, hostId);
            return;
          }
          return;
        }

        if (config.logLevel === 'debug') {
          const hex = Buffer.from(msgStr.length > 64 ? msgStr.slice(0, 64) : msgStr).toString('hex');
          const preview = JSON.stringify(msgStr.length > 30 ? msgStr.slice(0, 30) + '...' : msgStr);
          logger.debug(`[TerminalWS:${hostId}] Raw input frame (len=${msgStr.length}, hex=${hex}, preview=${preview})`);
        }
        session.write(msgStr);
      } catch (err: any) {
        logger.warn(`[TerminalWS:${hostId}] Message parse exception: ${err.message}`);
        if (isBinary === true && ((ws as any)._binaryControl === true || firstByte === BIN_MSG_TYPE.CONTROL_JSON)) {
          return;
        }
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
