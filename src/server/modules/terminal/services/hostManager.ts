import logger from '../../../../utils/logger';
import { rpcDispatcher, RpcDispatcher } from './rpcDispatcher';

export interface ManagedHost {
  id: string;
  name: string;
  hostname: string;
  ip: string;
  platform: string;
  status: 'online' | 'offline';
  lastSeen: number;
  type: 'agent';
  machineId?: string;
  agentWs?: any;
}

export interface ITerminalSession {
  attach(ws: any): void;
  detach(ws: any): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  reset(notifyClients?: boolean, resetAgentPty?: boolean): void;
  destroy(): void;
}

/**
 * Strips terminal query escape sequences from historical replayed streams
 * (such as OSC 10/11 color queries, DA device attribute queries, CPR cursor requests)
 * to prevent attached xterm.js clients from generating synthetic response reports back into the shell.
 */
export function stripTerminalQuerySequences(stream: string): string {
  if (!stream || typeof stream !== 'string') return '';
  const stripped = stream.replace(
    /\x1b(?:\](?:4|10|11|12);\?(?:\x1b\\|\x07)|\[[>?=]?(?:0)?c|\[\??6n|\[\??\d+\$p|\[>0?q|\[(?:14|18|19|20|21)t)/g,
    ''
  );
  if (!stripped) return '';
  // Prepend soft style reset and show cursor to ensure pristine state after replay
  return '\x1b[0m\x1b[?25h' + stripped;
}

export class RemoteAgentTerminalSession implements ITerminalSession {
  public hostId: string;
  private agentWs: any = null;
  private activeSockets: Set<any> = new Set();
  private historyBuffer: string[] = [];
  private totalBufferSize: number = 0;
  private readonly maxBufferSize: number = 200 * 1024; // 200KB scrollback
  private currentCols: number = 0;
  private currentRows: number = 0;

  constructor(hostId: string, agentWs?: any) {
    this.hostId = hostId;
    this.agentWs = agentWs;
  }

  public updateAgentWs(agentWs: any): void {
    this.agentWs = agentWs;
    this.currentCols = 0;
    this.currentRows = 0;
  }

  public getAgentWs(): any {
    return this.agentWs;
  }

  public getCurrentDimensions(): { cols: number; rows: number } {
    return { cols: this.currentCols, rows: this.currentRows };
  }

  public attach(ws: any): void {
    // Prune stale or closed sockets before attaching new socket
    for (const client of this.activeSockets) {
      if (!client || client.readyState > 1) {
        this.activeSockets.delete(client);
      }
    }
    this.activeSockets.add(ws);
    // Replay history buffer atomically as a single combined stream with query sequences stripped to prevent echo storms
    if (this.historyBuffer.length > 0 && ws.readyState === 1) {
      try {
        const fullStream = this.historyBuffer.join('');
        const sanitized = stripTerminalQuerySequences(fullStream);
        if (sanitized.length > 0) {
          ws.send(sanitized);
        }
      } catch {
        // Ignore socket write errors during replay
      }
    }
  }

  public detach(ws: any): void {
    this.activeSockets.delete(ws);
  }

  public write(data: string): void {
    if (this.agentWs && this.agentWs.readyState === 1) {
      try {
        this.agentWs.send(data);
      } catch (err: any) {
        logger.warn(`[RemoteAgentTerminal:${this.hostId}] Failed to send data to agent: ${err.message}`);
      }
    }
  }

  public resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    // Suppress redundant PTY resizes to prevent unnecessary SIGWINCH and prompt duplicates
    if (this.currentCols === cols && this.currentRows === rows) {
      return;
    }
    this.currentCols = cols;
    this.currentRows = rows;
    if (this.agentWs && this.agentWs.readyState === 1) {
      try {
        this.agentWs.send(`JSON:${JSON.stringify({ type: 'resize', cols, rows })}`);
      } catch (err: any) {
        logger.warn(`[RemoteAgentTerminal:${this.hostId}] Failed to send resize to agent: ${err.message}`);
      }
    }
  }

  public reset(notifyClients: boolean = true, resetAgentPty: boolean = false): void {
    this.historyBuffer = [];
    this.totalBufferSize = 0;
    this.currentCols = 0;
    this.currentRows = 0;
    if (resetAgentPty && this.agentWs && this.agentWs.readyState === 1) {
      try {
        this.agentWs.send(`JSON:${JSON.stringify({ type: 'reset' })}`);
      } catch (err: any) {
        logger.warn(`[RemoteAgentTerminal:${this.hostId}] Failed to send reset to agent: ${err.message}`);
      }
    }
    if (notifyClients) {
      for (const ws of this.activeSockets) {
        try {
          if (ws.readyState === 1) {
            ws.send(`JSON:${JSON.stringify({ type: 'reset' })}`);
            ws.send('\x1b[2J\x1b[H\x1b[3J');
          }
        } catch {
          // Ignore write errors
        }
      }
    }
  }

  public destroy(): void {
    this.activeSockets.clear();
    this.historyBuffer = [];
    this.totalBufferSize = 0;
    this.agentWs = null;
    this.currentCols = 0;
    this.currentRows = 0;
  }

  public handleData(data: string | Buffer): void {
    if (typeof data === 'string' && data.startsWith('JSON:')) {
      return;
    }
    const text = typeof data === 'string' ? data : data.toString('utf-8');
    this.historyBuffer.push(text);
    this.totalBufferSize += text.length;

    // If stream contains terminal clear scrollback sequence (\x1b[3J or \x1bc), compact buffer to purge stale screen history
    if (text.includes('\x1b[3J') || text.includes('\x1bc')) {
      const combined = this.historyBuffer.join('');
      const lastClearIdx = Math.max(combined.lastIndexOf('\x1b[3J'), combined.lastIndexOf('\x1bc'));
      if (lastClearIdx !== -1) {
        this.historyBuffer = [combined.slice(lastClearIdx)];
        this.totalBufferSize = this.historyBuffer[0].length;
      }
    }

    while (this.totalBufferSize > this.maxBufferSize && this.historyBuffer.length > 0) {
      const removed = this.historyBuffer.shift();
      if (removed) {
        this.totalBufferSize -= removed.length;
      }
    }

    const deadSockets: any[] = [];
    for (const ws of this.activeSockets) {
      try {
        if (ws.readyState === 1) {
          ws.send(data);
        } else {
          deadSockets.push(ws);
        }
      } catch {
        deadSockets.push(ws);
      }
    }
    for (const dead of deadSockets) {
      this.activeSockets.delete(dead);
    }
  }

  public getHistory(): string {
    return this.historyBuffer.join('');
  }
}

export class TerminalHostManager {
  public static readonly OFFLINE_HOST_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
  private hosts: Map<string, ManagedHost> = new Map();
  private sessions: Map<string, RemoteAgentTerminalSession> = new Map();
  private pruneTimer: NodeJS.Timeout | null = null;
  private rpcDispatcher: RpcDispatcher;

  constructor(rpcDispatcherInstance?: RpcDispatcher) {
    this.rpcDispatcher = rpcDispatcherInstance || new RpcDispatcher();
    // Schedule periodic sweep every hour (unref so it doesn't block process exit)
    this.pruneTimer = setInterval(() => {
      this.pruneOfflineHosts(TerminalHostManager.OFFLINE_HOST_TTL_MS);
    }, 60 * 60 * 1000);
    if (this.pruneTimer && typeof this.pruneTimer.unref === 'function') {
      this.pruneTimer.unref();
    }
  }

  public resolveCanonicalHostId(input?: string): string | null {
    if (!input || !input.trim()) return null;
    const target = input.trim();

    // 1. Exact ID match
    if (this.hosts.has(target)) return target;

    // 2. Exact Name match (prefer online node)
    const matchingByName: ManagedHost[] = [];
    for (const host of this.hosts.values()) {
      if (host.name === target) {
        matchingByName.push(host);
      }
    }
    if (matchingByName.length > 0) {
      const online = matchingByName.find(h => h.status === 'online');
      return (online || matchingByName[0]).id;
    }

    // 3. Short ID prefix match (minimum 4 chars, like Docker)
    if (target.length >= 4) {
      const matchingPrefix: ManagedHost[] = [];
      for (const host of this.hosts.values()) {
        if (host.id.toLowerCase().startsWith(target.toLowerCase())) {
          matchingPrefix.push(host);
        }
      }
      if (matchingPrefix.length === 1) {
        return matchingPrefix[0].id;
      }
      if (matchingPrefix.length > 1) {
        const online = matchingPrefix.find(h => h.status === 'online');
        if (online) return online.id;
      }
    }

    return null;
  }

  public pruneOfflineHosts(maxAgeMs: number = TerminalHostManager.OFFLINE_HOST_TTL_MS): string[] {
    const now = Date.now();
    const prunedIds: string[] = [];

    for (const [id, host] of this.hosts.entries()) {
      if (host.status === 'offline') {
        const session = this.sessions.get(id);
        // SAFETY GUARD: If session has an active open WebSocket, this host is NOT actually offline!
        // Auto-heal it back to online rather than pruning it.
        if (session && session.getAgentWs() && session.getAgentWs().readyState === 1) {
          host.status = 'online';
          host.lastSeen = now;
          logger.info(`[TerminalHostManager] Auto-healed active host ${id} during prune check`);
          continue;
        }

        const age = now - (host.lastSeen || 0);
        if (maxAgeMs <= 0 || age >= maxAgeMs) {
          prunedIds.push(id);
          if (session) {
            session.destroy();
            this.sessions.delete(id);
          }
          this.clearPendingRpcForHost(id);
          this.hosts.delete(id);
          logger.info(`[TerminalHostManager] Pruned offline host: ${id} (lastSeen: ${new Date(host.lastSeen).toISOString()})`);
        }
      }
    }

    return prunedIds;
  }

  public getHosts(): ManagedHost[] {
    this.pruneOfflineHosts(TerminalHostManager.OFFLINE_HOST_TTL_MS);

    // Auto-heal any host with an active open WebSocket
    for (const [id, host] of this.hosts.entries()) {
      if (host.status === 'offline') {
        const session = this.sessions.get(id);
        if (session && session.getAgentWs() && session.getAgentWs().readyState === 1) {
          host.status = 'online';
          host.lastSeen = Date.now();
          logger.info(`[TerminalHostManager] Auto-healed active host to online: ${id}`);
        }
      }
    }

    const list = Array.from(this.hosts.values());
    return list.sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'online' ? -1 : 1;
      }
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  public getHost(hostIdOrName: string): ManagedHost | null {
    const canonicalId = this.resolveCanonicalHostId(hostIdOrName);
    if (!canonicalId) return null;
    const host = this.hosts.get(canonicalId);
    if (host && host.status === 'offline') {
      const session = this.sessions.get(canonicalId);
      if (session && session.getAgentWs() && session.getAgentWs().readyState === 1) {
        host.status = 'online';
        host.lastSeen = Date.now();
        logger.info(`[TerminalHostManager] Auto-healed active host to online: ${canonicalId} in getHost`);
      }
    }
    return host || null;
  }

  public getSession(hostIdOrName?: string): RemoteAgentTerminalSession | null {
    if (!hostIdOrName || !hostIdOrName.trim()) return null;
    const canonicalId = this.resolveCanonicalHostId(hostIdOrName);
    if (!canonicalId) return null;
    const host = this.hosts.get(canonicalId);
    const session = this.sessions.get(canonicalId);

    // Auto-heal if socket is active
    if (host && session && session.getAgentWs() && session.getAgentWs().readyState === 1) {
      if (host.status !== 'online') {
        host.status = 'online';
        host.lastSeen = Date.now();
        logger.info(`[TerminalHostManager] Auto-healed host status to online for ${canonicalId} in getSession`);
      }
      return session;
    }

    if (!host || host.status !== 'online') {
      return null;
    }
    return session || null;
  }

  public isAgentOnline(agentIdentifier?: string): boolean {
    if (!agentIdentifier) return false;
    const hostId = this.resolveCanonicalHostId(agentIdentifier);
    if (!hostId) return false;
    const host = this.hosts.get(hostId);
    if (!host || host.status !== 'online') return false;
    const session = this.sessions.get(hostId);
    if (!session) return false;
    const ws = session.getAgentWs();
    return Boolean(ws && ws.readyState === 1);
  }

  public getAgentWs(agentIdentifier?: string): any | null {
    if (!agentIdentifier) return null;
    const hostId = this.resolveCanonicalHostId(agentIdentifier);
    if (!hostId) return null;
    const host = this.hosts.get(hostId);
    if (!host || host.status !== 'online') return null;
    const session = this.sessions.get(hostId);
    if (!session) return null;
    const ws = session.getAgentWs();
    if (ws && ws.readyState === 1) {
      return ws;
    }
    return null;
  }

  public registerHost(metadata: { id: string; name?: string; hostname?: string; ip?: string; platform?: string; type?: string }, agentWs?: any) {
    return this.registerAgent({
      hostId: metadata.id,
      name: metadata.name,
      hostname: metadata.hostname,
      ip: metadata.ip,
      platform: metadata.platform,
      agentWs,
    });
  }

  public unregisterHost(hostId: string, closingWs?: any): void {
    return this.unregisterAgent(hostId, closingWs);
  }

  public registerAgent(metadata: {
    hostId: string;
    name?: string;
    hostname?: string;
    ip?: string;
    platform?: string;
    machineId?: string;
    agentWs: any;
  }): { success: boolean; host?: ManagedHost; error?: string } {
    const id = metadata.hostId.trim();
    const targetName = (metadata.name || metadata.hostname || id).trim();
    const machineId = (metadata.machineId || id).trim();

    // 1. Check for Machine ID conflict against active (online) nodes
    for (const [existingId, existingHost] of this.hosts.entries()) {
      if (existingHost.machineId === machineId) {
        const existingWs = existingHost.agentWs || this.sessions.get(existingId)?.getAgentWs();
        if (existingHost.status === 'online' && existingWs !== metadata.agentWs) {
          if (existingId !== id) {
            logger.warn(`[TerminalHostManager] Rejecting duplicate machine agent: machineId "${machineId}" is already held by active node "${existingHost.name}" (${existingId})`);
            return {
              success: false,
              error: `Conflict: Machine (${machineId}) already has an active agent '${existingHost.name}' (ID: ${existingId}) connected to this Hub. Each machine can only have ONE agent per Hub.`
            };
          }
        } else if (existingHost.status === 'offline') {
          if (existingId !== id) {
            // Auto-prune offline host to allow clean takeover
            const session = this.sessions.get(existingId);
            if (session) {
              session.destroy();
              this.sessions.delete(existingId);
            }
            this.clearPendingRpcForHost(existingId);
            this.hosts.delete(existingId);
            logger.info(`[TerminalHostManager] Pruned offline host with matching machineId "${machineId}": ${existingId}`);
          }
        }
      }
    }

    // 2. Check for name conflict against ACTIVE (online) nodes
    for (const [existingId, existingHost] of this.hosts.entries()) {
      if (existingId !== id && existingHost.name === targetName) {
        if (existingHost.status === 'online') {
          logger.warn(`[TerminalHostManager] Rejecting duplicate online host name "${targetName}" from ${id} (held by ${existingId})`);
          return {
            success: false,
            error: `Conflict: Host name '${targetName}' is already in use by active node '${existingId}'`
          };
        } else {
          // Auto-prune offline host to allow takeover
          const session = this.sessions.get(existingId);
          if (session) {
            session.destroy();
            this.sessions.delete(existingId);
          }
          this.clearPendingRpcForHost(existingId);
          this.hosts.delete(existingId);
          logger.info(`[TerminalHostManager] Pruned offline host with matching name "${targetName}": ${existingId}`);
        }
      }
    }

    // 3. Register or update host strictly under `id`
    let host = this.hosts.get(id);
    if (!host) {
      host = {
        id,
        name: targetName,
        hostname: metadata.hostname || id,
        ip: metadata.ip || '127.0.0.1',
        platform: metadata.platform || 'linux',
        status: 'online',
        lastSeen: Date.now(),
        type: 'agent',
        machineId,
        agentWs: metadata.agentWs,
      };
      this.hosts.set(id, host);
    } else {
      host.status = 'online';
      host.lastSeen = Date.now();
      host.name = targetName;
      host.machineId = machineId;
      host.agentWs = metadata.agentWs;
      if (metadata.hostname) host.hostname = metadata.hostname;
      if (metadata.ip) host.ip = metadata.ip;
      if (metadata.platform) host.platform = metadata.platform;
    }

    let session = this.sessions.get(id);
    if (!session) {
      session = new RemoteAgentTerminalSession(id, metadata.agentWs);
      this.sessions.set(id, session);
    } else {
      // Agent reconnecting -> Supersede old WebSocket if different
      const oldWs = session.getAgentWs();
      if (oldWs && oldWs !== metadata.agentWs) {
        logger.info(`[TerminalHostManager] Superseding old agent socket for: ${id}`);
        try {
          if (oldWs.readyState === 1) {
            oldWs.close(1000, 'Superseded by new agent connection');
          }
        } catch {}
        session.updateAgentWs(metadata.agentWs);
        this.clearPendingRpcForHost(id);
      } else {
        session.updateAgentWs(metadata.agentWs);
      }
    }

    logger.info(`[TerminalHostManager] Agent registered: ${id} (${host.name})`);
    return { success: true, host };
  }

  public isCurrentAgentWs(hostId: string, ws: any): boolean {
    const canonicalId = this.resolveCanonicalHostId(hostId) || hostId;
    const session = this.sessions.get(canonicalId);
    if (!session) return false;
    const currentWs = session.getAgentWs();
    if (!currentWs) return false;
    return currentWs === ws;
  }

  public unregisterAgent(hostId: string, closingWs?: any): void {
    const canonicalId = this.resolveCanonicalHostId(hostId) || hostId;
    const session = this.sessions.get(canonicalId);

    // Stale socket close protection:
    // If closingWs is specified and doesn't match the current active agent socket in the session,
    // this event is from an old superseded connection. Do NOT mark offline!
    if (closingWs && session && session.getAgentWs() && session.getAgentWs() !== closingWs) {
      logger.info(`[TerminalHostManager] Ignoring unregister from stale agent socket for: ${canonicalId}`);
      return;
    }

    const host = this.hosts.get(canonicalId);
    if (host && host.type === 'agent') {
      host.status = 'offline';
      host.lastSeen = Date.now();
      host.agentWs = null;
      logger.info(`[TerminalHostManager] Agent unregistered/offline: ${canonicalId}`);
    }
    if (session && (!closingWs || session.getAgentWs() === closingWs)) {
      session.updateAgentWs(null);
      this.clearPendingRpcForHost(canonicalId, `Agent ${canonicalId} disconnected; RPC cancelled`);
    }
  }

  public touchAgent(
    hostId: string,
    ws?: any,
    metadata?: { name?: string; hostname?: string; ip?: string; platform?: string }
  ): void {
    const canonicalId = this.resolveCanonicalHostId(hostId) || hostId;
    let host = this.hosts.get(canonicalId);
    if (!host) {
      if (ws) {
        this.registerAgent({
          hostId: canonicalId,
          name: metadata?.name,
          hostname: metadata?.hostname,
          ip: metadata?.ip,
          platform: metadata?.platform,
          agentWs: ws,
        });
      }
      return;
    }

    const session = this.sessions.get(canonicalId);
    const currentWs = session ? session.getAgentWs() : null;

    // Guard against stale sockets:
    // If session already has an active open WebSocket that is NOT this `ws`,
    // then `ws` is an OLD STALE / superseded socket!
    // We must ignore this message and not let it hijack the session or status.
    if (session && currentWs && currentWs !== ws && currentWs.readyState === 1) {
      logger.info(`[TerminalHostManager] Ignoring touch from stale agent socket for: ${canonicalId}`);
      try {
        if (ws && typeof ws.close === 'function' && ws.readyState === 1) {
          ws.close(1000, 'Superseded by newer connection');
        }
      } catch {}
      return;
    }

    host.lastSeen = Date.now();
    if (host.status !== 'online') {
      host.status = 'online';
      logger.info(`[TerminalHostManager] Agent status restored to online via message: ${canonicalId}`);
    }

    if (session && ws && currentWs !== ws) {
      session.updateAgentWs(ws);
    }
  }

  public handleAgentData(hostId: string, data: any): void {
    const canonicalId = this.resolveCanonicalHostId(hostId) || hostId;
    const session = this.sessions.get(canonicalId);
    if (session) {
      session.handleData(data);
    }

    const host = this.hosts.get(canonicalId);
    if (host) {
      host.lastSeen = Date.now();
      host.status = 'online';
    }
  }

  public handleAgentRpcResponse(response: any): void {
    this.rpcDispatcher.handleAgentRpcResponse(response);
  }

  public handleAgentCmdRpcResponse(response: any): void {
    this.rpcDispatcher.handleAgentCmdRpcResponse(response);
  }

  public clearPendingRpcForHost(hostId: string, reason?: string): void {
    const canonicalId = this.resolveCanonicalHostId(hostId) || hostId;
    this.rpcDispatcher.clearPendingRpcForHost(canonicalId, reason);
  }

  public async executeCmdRpc(hostIdOrName: string, payload: { action: string; [key: string]: any }): Promise<any> {
    const canonicalId = this.resolveCanonicalHostId(hostIdOrName);
    if (!canonicalId) {
      return { success: false, error: `Agent "${hostIdOrName}" is offline or unavailable` };
    }
    const session = this.getSession(canonicalId);
    if (!session) {
      return { success: false, error: `Agent "${hostIdOrName}" is offline or unavailable` };
    }
    return this.rpcDispatcher.executeCmdRpc(session, canonicalId, payload);
  }

  public async executeFileRpc(
    hostIdOrName: string,
    payload: { action: string; path: string; params?: any },
    timeoutMs: number = 30000
  ): Promise<any> {
    const canonicalId = this.resolveCanonicalHostId(hostIdOrName);
    if (!canonicalId) {
      return { success: false, error: `Agent "${hostIdOrName}" is offline or unavailable` };
    }
    const session = this.getSession(canonicalId);
    if (!session) {
      return { success: false, error: `Agent "${hostIdOrName}" is offline or unavailable` };
    }
    return this.rpcDispatcher.executeFileRpc(session, canonicalId, payload, timeoutMs);
  }
}

export const terminalHostManager = new TerminalHostManager(rpcDispatcher);
export default terminalHostManager;
